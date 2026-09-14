"use strict";
// This process boundary deliberately exports no arbitrary child output, error
// message, command line, environment, credential or path. Raw streams remain
// separate, memory-bounded, and are wiped before returning closed-schema facts.
const { spawn } = require("node:child_process");

const STAGES = Object.freeze(["initialization", "dependencies_runtime", "version_checks", "package_install", "final_validation"]);
const EVENTS = Object.freeze(["start", "done", "failed"]);
const SAFE_VM_MARKER = /^VM_(BOOTSTRAP|INSTALLATION|HOST_PREFLIGHT)=(PASS|FAIL|ROOT_REQUIRED|HOST_MISMATCH|BUNDLE_MISSING|EXISTING_RUNTIME_REFUSED|NODE_MISMATCH|NODE_PATH_OCCUPIED|REFUSED|PREREQUISITE_MISSING|NODE_VERSION_MISMATCH|DEPENDENCIES_MISSING|EXISTING_TARGET_REFUSED|EXISTING_ACCOUNT_REFUSED|EXISTING_CGROUP_REFUSED)$/;
const MAX_SAFE_NOTES = 340;
const SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGBREAK", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR", "SIGSYS"]);
const SPAWN_ERRORS = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM", "EINVAL", "UNKNOWN"]);
const CLASSIFICATIONS = new Set(["installation_complete", "spawn_failure", "local_timeout", "local_abort", "process_signal", "transport_interrupted_unknown", "remote_command_failed", "local_stdin_failure", "collection_failure", "invalid_installation_protocol", "substep_failed", "completion_unconfirmed", "incomplete_installation_evidence"]);
const RESULT_KEYS = ["schema", "classification", "installationPassed", "exitCode", "signal", "timedOut", "aborted", "spawnFailed", "stdinFailed", "startedAtMs", "completedAtMs", "durationMs", "stdoutBytes", "stderrBytes", "captureLimitBytes", "captureTruncated", "retainedBytes", "markers", "lastCompletedStage", "failedStage", "failedStageExitCode", "finalMarkerReceived", "protocolInvalid", "remoteOutputNotes", "remoteOutputNotesTruncated", "remoteCaptureFailed", "collectionError", "spawnErrorCode", "retryPermitted"].sort();
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function inspectMarkers(markers) {
  let next = 0, active = null, failed = false, invalid = false, prior = 0, lastCompletedStage = null, failedStage = null, failedStageExitCode = null;
  for (const marker of markers) {
    if (marker.atMs < prior) invalid = true;
    prior = marker.atMs;
    if (failed) invalid = true;
    if (marker.event === "start") {
      if (active !== null || marker.stage !== STAGES[next] || marker.exitCode !== null) invalid = true;
      active = marker.stage;
    } else {
      if (active !== marker.stage || marker.stage !== STAGES[next]) invalid = true;
      if (marker.event === "done") {
        if (marker.exitCode !== 0) invalid = true;
        if (active === marker.stage && marker.stage === STAGES[next] && !failed) { lastCompletedStage = marker.stage; next++; }
      } else {
        if (!Number.isInteger(marker.exitCode) || marker.exitCode < 1 || marker.exitCode > 255) invalid = true;
        if (active === marker.stage && marker.stage === STAGES[next] && !failed) { failedStage = marker.stage; failedStageExitCode = marker.exitCode; }
        failed = true;
      }
      active = null;
    }
  }
  return { invalid, failed, lastCompletedStage, failedStage, failedStageExitCode, allCompleted: !invalid && !failed && next === STAGES.length && active === null };
}

function validSafeNote(note) {
  return exactKeys(note, ["stage", "stream", "kind", "value"]) && STAGES.includes(note.stage) && ["stdout", "stderr"].includes(note.stream) &&
    (note.kind === "marker" ? typeof note.value === "string" && SAFE_VM_MARKER.test(note.value) :
      ["bytes", "dropped"].includes(note.kind) ? nonnegative(note.value) :
        note.kind === "capture_failed" && Number.isInteger(note.value) && note.value >= 1 && note.value <= 255);
}

function createInstallDiagnosticParser() {
  const streams = { stdout: { buffer: Buffer.alloc(0), overlong: false }, stderr: { buffer: Buffer.alloc(0), overlong: false } };
  const markers = [];
  const remoteOutputNotes = [];
  let protocolInvalid = false, finalMarkerReceived = false, finished = false, remoteOutputNotesTruncated = false, remoteCaptureFailed = false;
  function parseLine(bytes, overlong) {
    const line = bytes.toString("utf8").replace(/\r$/, "");
    if (overlong) { if (line.startsWith("IA4INSTALL") || line.startsWith("IA4SAFE")) protocolInvalid = true; return; }
    if (line.startsWith("IA4SAFE")) {
      const noteMatch = /^IA4SAFE (initialization|dependencies_runtime|version_checks|package_install|final_validation) (stdout|stderr) (bytes|dropped|marker|capture_failed) ([^\s]+)$/.exec(line);
      const note = noteMatch ? { stage: noteMatch[1], stream: noteMatch[2], kind: noteMatch[3], value: noteMatch[3] === "marker" ? noteMatch[4] : /^[0-9]{1,16}$/.test(noteMatch[4]) ? Number(noteMatch[4]) : null } : null;
      if (!validSafeNote(note)) { protocolInvalid = true; return; }
      if (note.kind === "capture_failed") remoteCaptureFailed = true;
      if (remoteOutputNotes.length < MAX_SAFE_NOTES) remoteOutputNotes.push(note); else remoteOutputNotesTruncated = true;
      return;
    }
    if (line === "IA4INSTALL_COMPLETE=PASS") {
      if (finalMarkerReceived || !inspectMarkers(markers).allCompleted) protocolInvalid = true;
      finalMarkerReceived = true;
      return;
    }
    if (!line.startsWith("IA4INSTALL")) return;
    const match = /^IA4INSTALL (initialization|dependencies_runtime|version_checks|package_install|final_validation) (start|done|failed) ([0-9]{1,16}) (-|[0-9]{1,3})$/.exec(line);
    if (!match || finalMarkerReceived || markers.length >= STAGES.length * 2) { protocolInvalid = true; return; }
    const atMs = Number(match[3]), exitCode = match[4] === "-" ? null : Number(match[4]);
    if (!nonnegative(atMs) || (exitCode !== null && exitCode > 255) || (match[2] === "start" && exitCode !== null) || (match[2] === "done" && exitCode !== 0) || (match[2] === "failed" && (exitCode === null || exitCode < 1))) { protocolInvalid = true; return; }
    markers.push({ stage: match[1], event: match[2], atMs, exitCode, stream: currentStream });
    if (inspectMarkers(markers).invalid) protocolInvalid = true;
  }
  let currentStream = "stdout";
  function push(chunk, stream = "stdout") {
    if (finished || !Object.hasOwn(streams, stream) || (!Buffer.isBuffer(chunk) && typeof chunk !== "string")) throw new Error("vm_install_diagnostic_parser_input_invalid");
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), state = streams[stream];
    currentStream = stream;
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset), limit = end === -1 ? bytes.length : end;
      const room = Math.max(0, 256 - state.buffer.length), amount = Math.min(room, limit - offset);
      if (amount > 0) state.buffer = Buffer.concat([state.buffer, bytes.subarray(offset, offset + amount)]);
      if (limit - offset > room) state.overlong = true;
      if (end === -1) break;
      parseLine(state.buffer, state.overlong); state.buffer.fill(0); state.buffer = Buffer.alloc(0); state.overlong = false;
      offset = end + 1;
    }
  }
  function finish() {
    if (!finished) {
      for (const stream of ["stdout", "stderr"]) {
        currentStream = stream;
        if (streams[stream].buffer.length || streams[stream].overlong) parseLine(streams[stream].buffer, streams[stream].overlong);
        streams[stream].buffer.fill(0); streams[stream].buffer = Buffer.alloc(0);
      }
      finished = true;
    }
    const observed = inspectMarkers(markers);
    return { markers: markers.map(marker => ({ ...marker })), lastCompletedStage: observed.lastCompletedStage,
      failedStage: observed.failedStage, failedStageExitCode: observed.failedStageExitCode,
      finalMarkerReceived, protocolInvalid: protocolInvalid || observed.invalid,
      remoteOutputNotes: remoteOutputNotes.map(note => ({ ...note })), remoteOutputNotesTruncated, remoteCaptureFailed };
  }
  return { push, finish };
}

function classifyInstallDiagnostic(result) {
  if (result.spawnFailed) return "spawn_failure";
  if (result.aborted) return "local_abort";
  if (result.timedOut) return "local_timeout";
  if (result.signal !== null) return "process_signal";
  if (result.exitCode === 255) return "transport_interrupted_unknown";
  if (result.collectionError || result.remoteCaptureFailed) return "collection_failure";
  const observed = inspectMarkers(result.markers);
  if (!result.protocolInvalid && observed.failed) return "substep_failed";
  if (result.exitCode !== null && result.exitCode !== 0) return "remote_command_failed";
  if (result.stdinFailed) return "local_stdin_failure";
  if (result.protocolInvalid) return "invalid_installation_protocol";
  if (!result.finalMarkerReceived || result.exitCode === null) return "completion_unconfirmed";
  if (!observed.allCompleted) return "incomplete_installation_evidence";
  return "installation_complete";
}

function validateInstallDiagnostic(result) {
  if (!exactKeys(result, RESULT_KEYS) || result.schema !== 1 || !CLASSIFICATIONS.has(result.classification) || result.retryPermitted !== false ||
      !["installationPassed", "timedOut", "aborted", "spawnFailed", "stdinFailed", "finalMarkerReceived", "protocolInvalid", "remoteOutputNotesTruncated", "remoteCaptureFailed", "collectionError"].every(key => typeof result[key] === "boolean") ||
      !(result.exitCode === null || (Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 0xffffffff)) ||
      !(result.signal === null || SIGNALS.has(result.signal)) || !(result.spawnErrorCode === null || SPAWN_ERRORS.has(result.spawnErrorCode)) ||
      !["startedAtMs", "completedAtMs", "durationMs", "stdoutBytes", "stderrBytes", "captureLimitBytes"].every(key => nonnegative(result[key])) ||
      result.completedAtMs < result.startedAtMs || result.durationMs !== result.completedAtMs - result.startedAtMs || result.captureLimitBytes > 1024 * 1024 ||
      !exactKeys(result.captureTruncated, ["stdout", "stderr"]) || !exactKeys(result.retainedBytes, ["stdout", "stderr"]) ||
      !["stdout", "stderr"].every(stream => typeof result.captureTruncated[stream] === "boolean" && nonnegative(result.retainedBytes[stream]) && result.retainedBytes[stream] === Math.min(result[stream + "Bytes"], result.captureLimitBytes) && result.captureTruncated[stream] === (result[stream + "Bytes"] > result.captureLimitBytes)) ||
      !Array.isArray(result.remoteOutputNotes) || result.remoteOutputNotes.length > MAX_SAFE_NOTES || result.remoteOutputNotes.some(note => !validSafeNote(note)) ||
      (result.remoteOutputNotesTruncated && result.remoteOutputNotes.length !== MAX_SAFE_NOTES) ||
      (result.remoteOutputNotes.some(note => note.kind === "capture_failed") && !result.remoteCaptureFailed) ||
      (result.remoteCaptureFailed && !result.remoteOutputNotesTruncated && !result.remoteOutputNotes.some(note => note.kind === "capture_failed")) ||
      !Array.isArray(result.markers) || result.markers.length > STAGES.length * 2 ||
      result.markers.some(marker => !exactKeys(marker, ["stage", "event", "atMs", "exitCode", "stream"]) || !STAGES.includes(marker.stage) || !EVENTS.includes(marker.event) || !nonnegative(marker.atMs) || !["stdout", "stderr"].includes(marker.stream) || !(marker.exitCode === null || (Number.isInteger(marker.exitCode) && marker.exitCode >= 0 && marker.exitCode <= 255)) || (marker.event === "start" && marker.exitCode !== null) || (marker.event === "done" && marker.exitCode !== 0) || (marker.event === "failed" && (marker.exitCode === null || marker.exitCode < 1)))) return false;
  const observed = inspectMarkers(result.markers);
  if (result.lastCompletedStage !== observed.lastCompletedStage || result.failedStage !== observed.failedStage || result.failedStageExitCode !== observed.failedStageExitCode || (observed.invalid && !result.protocolInvalid) ||
      (result.finalMarkerReceived && !observed.allCompleted && !result.protocolInvalid) || (result.spawnFailed !== (result.spawnErrorCode !== null))) return false;
  return result.classification === classifyInstallDiagnostic(result) && result.installationPassed === (result.classification === "installation_complete");
}

function runDiagnosticProcess(command, args, opts = {}) {
  const { signal = null, timeoutMs = 20000, maxBytes = 65536, stdin = null, env = null } = opts;
  if (typeof command !== "string" || !command.length || command.includes("\0") || !Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0")) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 * 60 * 60 * 1000 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1024 * 1024 || (stdin !== null && !Buffer.isBuffer(stdin) && typeof stdin !== "string") || (signal !== null && (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) || (env !== null && (typeof env !== "object" || Array.isArray(env)))) return Promise.reject(new Error("vm_install_diagnostic_options_invalid"));
  const sourceEnv = env || process.env, safeEnv = { LANG: "C.UTF-8" };
  for (const key of ["PATH", "SystemRoot", "ProgramData"]) if (typeof sourceEnv[key] === "string" && !sourceEnv[key].includes("\0")) safeEnv[key] = sourceEnv[key];
  return new Promise(resolve => {
    const startedAtMs = Date.now(), parser = createInstallDiagnosticParser(), captures = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 }, retained = { stdout: 0, stderr: 0 };
    let child, timer, killTimer, closed = false, timedOut = false, aborted = false, spawnFailed = false, stdinFailed = false, collectionError = false, spawnErrorCode = null;
    function finish(exitCode, receivedSignal) {
      if (closed) return; closed = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      const completedAtMs = Math.max(startedAtMs, Date.now());
      let parsed;
      try { parsed = parser.finish(); } catch { collectionError = true; parsed = { markers: [], lastCompletedStage: null, failedStage: null, failedStageExitCode: null, finalMarkerReceived: false, protocolInvalid: true, remoteOutputNotes: [], remoteOutputNotesTruncated: false, remoteCaptureFailed: false }; }
      for (const chunks of Object.values(captures)) for (const bytes of chunks) bytes.fill(0);
      const result = { schema: 1, classification: "completion_unconfirmed", installationPassed: false,
        exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 0xffffffff ? exitCode : null,
        signal: SIGNALS.has(receivedSignal) ? receivedSignal : null, timedOut, aborted, spawnFailed, stdinFailed,
        startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs, stdoutBytes: sizes.stdout, stderrBytes: sizes.stderr, captureLimitBytes: maxBytes,
        captureTruncated: { stdout: sizes.stdout > maxBytes, stderr: sizes.stderr > maxBytes }, retainedBytes: { ...retained },
        ...parsed, collectionError, spawnErrorCode, retryPermitted: false };
      result.classification = classifyInstallDiagnostic(result); result.installationPassed = result.classification === "installation_complete";
      resolve(result);
    }
    function kill() {
      if (!child || closed) return;
      try { child.kill("SIGKILL"); } catch { collectionError = true; }
      // A local deadline cannot assert remote termination. Stop retaining local
      // handles even if a broken pipe prevents close; the controller must collect
      // remotely and destroy its resource, never repeat this installation.
      killTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); finish(null, null); }, 1000);
      killTimer.unref?.();
    }
    function abort() { if (!closed) { aborted = true; kill(); } }
    if (signal?.aborted) { aborted = true; finish(null, null); return; }
    try { child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: safeEnv }); }
    catch (error) { spawnFailed = true; spawnErrorCode = SPAWN_ERRORS.has(error.code) ? error.code : "UNKNOWN"; finish(null, null); return; }
    timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { spawnFailed = true; spawnErrorCode = SPAWN_ERRORS.has(error.code) ? error.code : "UNKNOWN"; });
    child.once("close", finish);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", data => {
        if (closed) return;
        sizes[stream] += data.length;
        const amount = Math.min(data.length, Math.max(0, maxBytes - retained[stream]));
        if (amount > 0) { captures[stream].push(Buffer.from(data.subarray(0, amount))); retained[stream] += amount; }
        // Parsing continues after the raw capture cap. Only bounded, whitelisted
        // protocol lines survive, so a final marker is not lost to apt/npm noise.
        try { parser.push(data, stream); } catch { collectionError = true; }
      });
      child[stream].on("error", () => { collectionError = true; });
    }
    child.stdin.on("error", () => { stdinFailed = true; });
    child.stdin.end(stdin);
  });
}

module.exports = { STAGES, createInstallDiagnosticParser, classifyInstallDiagnostic, validateInstallDiagnostic, runDiagnosticProcess };
