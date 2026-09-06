"use strict";

// Controlled Linux laboratory only. This module does not spawn anything. It
// signals only leader witnesses issued here after a pinned worker was found as
// the child of this harness (or of its direct child host).
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const WORKER_SHA256 = "5da2ebb3f546863804de0ce78a40db8dd3b76e969628cd55a56b703312dc8a52";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const OPERATION = `/var/data/\\.ia4tube-recovery-c/${UUID}`;
const ARCHIVE = new RegExp(`^${OPERATION}/01-data-dir-posix\\.tar$`);
const LIST = new RegExp(`^${OPERATION}/files\\.list$`);
const owned = new WeakMap();
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function need(value, code) { if (!value) fail(code); }
function gate() { need(process.platform === "linux" && process.env.IA4TUBE_LINUX_PHYSICAL === "1" && typeof process.getuid === "function" && process.getuid() === 0, "process_lab_gate_refused"); }
function pidValue(value) { need(Number.isSafeInteger(value) && value > 1 && value <= 999999999, "process_pid_refused"); return value; }
function timeoutValue(value) { need(Number.isSafeInteger(value) && value > 0 && value <= 30000, "process_timeout_refused"); return value; }
function parseStat(text, expectedPid) {
  const end = text.lastIndexOf(") "), start = text.indexOf(" (");
  need(start > 0 && end > start && Number(text.slice(0, start)) === expectedPid, "process_stat_invalid");
  const fields = text.slice(end + 2).trim().split(/\s+/);
  need(fields.length >= 20 && /^[RSDZTWtXxIKP]$/.test(fields[0]) && /^[0-9]+$/.test(fields[19]), "process_stat_invalid");
  const ppid = Number(fields[1]), pgid = Number(fields[2]);
  need(Number.isSafeInteger(ppid) && ppid >= 0 && Number.isSafeInteger(pgid) && pgid > 0, "process_stat_invalid");
  return { pid: expectedPid, ppid, pgid, state: fields[0], startTime: fields[19] };
}
async function statProcess(pid) {
  try { return parseStat(await fsp.readFile(`/proc/${pid}/stat`, "utf8"), pid); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; fail("process_observation_failed"); }
}
async function children(pid) {
  try {
    const text = (await fsp.readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
    if (!text) return [];
    const values = text.split(/\s+/);
    need(values.length <= 256 && values.every(value => /^[1-9][0-9]{0,8}$/.test(value)), "process_children_invalid");
    return values.map(Number);
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; fail("process_children_failed"); }
}
async function argvFor(pid) {
  let bytes;
  try {
    bytes = await fsp.readFile(`/proc/${pid}/cmdline`);
    need(bytes.length <= 8192 && (bytes.length === 0 || bytes[bytes.length - 1] === 0), "process_argv_invalid");
    if (!bytes.length) return [];
    const text = bytes.toString("utf8");
    need(Buffer.from(text).equals(bytes), "process_argv_invalid");
    return text.slice(0, -1).split("\0");
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; fail("process_argv_refused"); }
  finally { if (bytes) bytes.fill(0); }
}
async function pinnedWorker(workerPath) {
  need(typeof workerPath === "string" && path.isAbsolute(workerPath) && path.basename(workerPath) === "capture-worker.js", "process_worker_path_refused");
  need(await fsp.realpath(workerPath) === workerPath, "process_worker_path_refused");
  const info = await fsp.lstat(workerPath);
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 1048576, "process_worker_path_refused");
  need(crypto.createHash("sha256").update(await fsp.readFile(workerPath)).digest("hex") === WORKER_SHA256, "process_worker_pin_mismatch");
  return workerPath;
}
function validTarArgv(argv) {
  if (argv[0] !== "/usr/bin/tar") return false;
  if (argv.length === 2 && argv[1] === "--version") return true;
  if (!["--create", "--compare"].includes(argv[1])) return false;
  const prefix = ["--format=pax", "--numeric-owner", "--acls", "--xattrs", "--xattrs-include=*", "--file"];
  if (!prefix.every((value, i) => argv[i + 2] === value) || argv[9] !== "--directory" || argv[10] !== "/var/data") return false;
  if (argv[1] === "--compare") return argv.length === 11 && ARCHIVE.test(argv[8]);
  return argv.length === 16 && argv[8] === "/proc/self/fd/3" &&
    ["--no-recursion", "--null", "--verbatim-files-from", "--files-from"].every((value, i) => argv[i + 11] === value) && LIST.test(argv[15]);
}
function publicProcess(record, argv) { return Object.freeze({ ...record, argv: Object.freeze([...argv]) }); }
async function inspectProcess(pid) {
  gate(); pidValue(pid);
  const first = await statProcess(pid);
  if (!first) return null;
  const argv = await argvFor(pid);
  if (!argv) return null;
  if (!argv.length) {
    need(first.state === "Z" || first.state === "X", "process_identity_unavailable");
    return publicProcess(first, []);
  }
  let exe;
  try { exe = await fsp.readlink(`/proc/${pid}/exe`); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; fail("process_executable_unavailable"); }
  const nodeExe = await fsp.realpath(process.execPath);
  if (exe === nodeExe && argv.length === 2 && path.basename(argv[1]) === "capture-worker.js") {
    need(await fsp.realpath(argv[0]) === nodeExe, "process_node_argv_refused");
    await pinnedWorker(argv[1]);
  } else if (exe === await fsp.realpath("/usr/bin/tar") && validTarArgv(argv)) {
    const parent = await inspectProcess(first.ppid);
    need(parent && parent.argv.length === 2 && path.basename(parent.argv[1]) === "capture-worker.js" && parent.pgid === first.pgid, "process_tar_parent_refused");
  } else fail("process_unrecognized_argv_refused");
  const last = await statProcess(pid);
  if (!last) return null;
  need(last.startTime === first.startTime && last.pgid === first.pgid, "process_identity_changed");
  return publicProcess(last, argv);
}
async function waitForWorker(hostPid, workerPath, { timeoutMs = 10000, phase = "worker" } = {}) {
  gate(); pidValue(hostPid); timeoutValue(timeoutMs);
  need(phase === "worker" || phase === "tar", "process_phase_refused");
  await pinnedWorker(workerPath);
  need(hostPid === process.pid || (await children(process.pid))?.includes(hostPid), "process_host_not_owned");
  const originalHost = await statProcess(hostPid);
  need(originalHost, "process_host_absent");
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const host = await statProcess(hostPid);
    need(host && host.startTime === originalHost.startTime, "process_host_changed");
    for (const candidate of await children(hostPid) || []) {
      const record = await statProcess(candidate), argv = await argvFor(candidate);
      if (!record || record.ppid !== hostPid || record.pgid !== candidate || !argv || argv.length !== 2 || argv[1] !== workerPath) continue;
      const leader = await inspectProcess(candidate);
      if (!leader || leader.ppid !== hostPid || leader.pgid !== leader.pid || leader.argv[1] !== workerPath) continue;
      let phaseProcess = leader;
      if (phase === "tar") {
        phaseProcess = null;
        for (const tarPid of await children(leader.pid) || []) {
          const tarArgs = await argvFor(tarPid);
          if (!tarArgs || !validTarArgv(tarArgs) || !["--create", "--compare"].includes(tarArgs[1])) continue;
          const tar = await inspectProcess(tarPid);
          if (tar && tar.ppid === leader.pid && tar.pgid === leader.pgid) { phaseProcess = tar; break; }
        }
        if (!phaseProcess) continue;
      }
      need(leader.pid !== process.pid && leader.pgid > 1, "process_group_refused");
      owned.set(leader, { hostPid, hostStartTime: originalHost.startTime, workerPath });
      return Object.freeze({ leader, observedPhase: phase, phaseProcess });
    }
    await pause(10);
  }
  fail("process_worker_phase_timeout");
}
async function matchingLeader(witness) {
  gate(); need(witness && owned.has(witness) && witness.pid === witness.pgid && witness.pid !== process.pid, "process_witness_not_owned");
  const authority = owned.get(witness), current = await inspectProcess(witness.pid);
  if (!current) return null;
  need(current.pid === witness.pid && current.startTime === witness.startTime && current.pgid === witness.pgid, "process_identity_changed");
  // A matching zombie has no executable argv to authorize a new signal. It is
  // still counted by waitGroupEmpty and must be reaped, never called empty.
  if (current.state === "Z" || current.state === "X") return null;
  need(current.argv.length === 2 && current.argv[1] === authority.workerPath, "process_identity_changed");
  if (current.ppid === authority.hostPid) {
    const host = await statProcess(authority.hostPid);
    need(host && host.startTime === authority.hostStartTime, "process_parent_identity_changed");
  } else {
    // The container's --init owns PID1 and reaps the orphan after a deliberate
    // host crash. Numeric reparenting alone never grants signalling authority.
    need(current.ppid === 1 && await statProcess(authority.hostPid) === null, "process_reparenting_refused");
  }
  return current;
}
async function signalOwned(witness, signal) {
  const current = await matchingLeader(witness);
  if (!current) return { sent: false, code: "process_leader_absent" };
  try { process.kill(-witness.pgid, signal); return { sent: true, pid: witness.pid, pgid: witness.pgid, signal }; }
  catch (error) { if (error.code === "ESRCH") return { sent: false, code: "process_group_absent" }; fail("process_signal_failed"); }
}
async function stopOwnedGroup(witness) { return signalOwned(witness, "SIGSTOP"); }
async function continueOwnedGroup(witness) { return signalOwned(witness, "SIGCONT"); }
async function terminateOwnedGroup(witness) {
  const term = await signalOwned(witness, "SIGTERM");
  const continued = await signalOwned(witness, "SIGCONT");
  return { term, continued }; // No SIGKILL escalation; container cleanup is external.
}
async function waitGroupEmpty(witness, timeoutMs = 10000) {
  gate(); timeoutValue(timeoutMs); need(witness && owned.has(witness), "process_witness_not_owned");
  const deadline = performance.now() + timeoutMs;
  let emptyObservations = 0, lastMembers = [];
  while (performance.now() < deadline) {
    const currentLeader = await statProcess(witness.pid);
    need(!currentLeader || (currentLeader.startTime === witness.startTime && currentLeader.pgid === witness.pgid), "process_identity_changed");
    const entries = await fsp.readdir("/proc"), members = [];
    for (const entry of entries) {
      if (!/^[1-9][0-9]{0,8}$/.test(entry)) continue;
      const record = await statProcess(Number(entry));
      if (record?.pgid === witness.pgid) members.push({ pid: record.pid, ppid: record.ppid, pgid: record.pgid, state: record.state, startTime: record.startTime });
    }
    let kernelGroupPresent = true;
    try { process.kill(-witness.pgid, 0); }
    catch (error) { if (error.code === "ESRCH") kernelGroupPresent = false; else fail("process_group_state_unknown"); }
    lastMembers = members;
    if (members.length === 0 && !kernelGroupPresent) emptyObservations++; else emptyObservations = 0;
    if (emptyObservations === 2) return { empty: true, pid: witness.pid, pgid: witness.pgid, observations: 2, members: [], zombiesCountedAsPresent: true };
    await pause(25);
  }
  return { empty: false, pid: witness.pid, pgid: witness.pgid, code: "process_group_not_empty_timeout", members: lastMembers, zombiesCountedAsPresent: true };
}

async function assertNoCaptureProcesses(workerPath) {
  gate(); await pinnedWorker(workerPath);
  const tarExe = await fsp.realpath("/usr/bin/tar");
  for (const entry of await fsp.readdir("/proc")) {
    if (!/^[1-9][0-9]{0,8}$/.test(entry)) continue;
    const pid = Number(entry), before = await statProcess(pid);
    if (!before) continue;
    need(before.state !== "Z" && before.state !== "X", "process_unreaped_process_remains");
    const argv = await argvFor(pid);
    if (argv === null) continue; // Disappeared during observation, not a claim about a live PID.
    need(argv.length > 0, "process_capture_absence_unknown");
    // Reject the known script under any parent, including unregistered orphans.
    // An unexpected argv with that filename is also refused, never displayed.
    need(!argv.some(argument => argument === workerPath || path.basename(argument) === "capture-worker.js"), "process_capture_remains");
    let exe;
    try { exe = await fsp.readlink(`/proc/${pid}/exe`); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") {
      need(await statProcess(pid) === null, "process_capture_absence_unknown"); continue;
    } fail("process_capture_absence_unknown"); }
    need(exe !== tarExe && argv[0] !== "/usr/bin/tar", "process_tar_remains");
    const after = await statProcess(pid);
    if (after) need(after.startTime === before.startTime && after.state !== "Z" && after.state !== "X", "process_capture_absence_unknown");
  }
  return { empty: true, scope: "current-proc-namespace", zombiesCountedAsPresent: true };
}

module.exports = { inspectProcess, waitForWorker, stopOwnedGroup, continueOwnedGroup, terminateOwnedGroup, waitGroupEmpty, assertNoCaptureProcesses };
