"use strict";
// Fixed synthetic sequence only. This file contains no provider API/credential.
const fs = require("node:fs/promises"), path = require("node:path"), { spawn } = require("node:child_process");
const { MANIFEST, sha256, canonical } = require("./vm-proof-manifest");
const STATE = "/var/lib/ia4tube-media/state/proof-run";
const ROOT = "/opt/ia4tube-media/proof";
function fail(code) { throw new Error("vm_proof_guest_" + code); }
const FAILURE_STAGES = new Set(["platform", "installation-record", "coordinator-identity", "launcher-identity", "executor-configuration",
  "runtime-probe", "capabilities", "scratch-quota", "case-body", "guest-parser", "guest-launch"]);
const FAILURE_CODES = new Set(["assertion_failed", "missing_path", "permission_denied", "already_exists", "unexpected_error", "subprocess_failed",
  "media_process_linux_installed_path_invalid", "media_process_linux_installed_record_invalid", "media_process_linux_installed_launcher_invalid",
  "media_process_linux_installed_path_symlink", "media_process_linux_installed_path_owner", "media_process_linux_installed_path_writable",
  "media_process_linux_installed_path_type", "media_process_linux_installed_path_hardlink", "media_process_linux_installed_file_writable",
  "media_process_linux_capabilities_unavailable", "media_process_installed_configuration_invalid", "media_process_linux_configuration_invalid",
  "media_process_path_invalid", "vm_proof_guest_case_receipt_invalid", "vm_proof_guest_total_receipt_invalid",
  "vm_proof_guest_total_receipt_missing", "vm_proof_guest_duplicate_metrics", "vm_proof_guest_metrics_invalid"]);
for (const stage of ["host_identity", "installed_accounts", "installed_caller", "installed_ancestry", "installed_paths", "volume_mount", "volume_backing",
  "pidfd", "jail_prepare", "cgroup", "clone", "assignment", "release", "child_namespace", "child_privileges", "child_probe", "child_stdio", "child_exec", "child_failed", "cleanup"])
  FAILURE_CODES.add("media_process_linux_probe_" + stage);
function validateFailure(value) {
  return value === null || value && Object.keys(value).sort().join(",") === "code,stage" && FAILURE_STAGES.has(value.stage) && FAILURE_CODES.has(value.code);
}
function closedFailure(error, stage = "case-body") {
  const mapping = { ERR_ASSERTION: "assertion_failed", ENOENT: "missing_path", EACCES: "permission_denied", EPERM: "permission_denied", EEXIST: "already_exists" };
  const value = mapping[error?.code] || (FAILURE_CODES.has(error?.code) ? error.code : FAILURE_CODES.has(error?.message) ? error.message : "unexpected_error");
  return { stage: FAILURE_STAGES.has(stage) ? stage : "case-body", code: value };
}
function validateMetrics(metrics) {
  return metrics === null || metrics && Object.keys(metrics).sort().join(",") === "decodedSeconds,peakTasks,peakTreeMemoryBytes,preparationCpuMs,preparationElapsedMs,sequenceElapsedMs,sourceBytes" &&
    Object.values(metrics).every(n => Number.isFinite(n) && n >= 0 && n <= 10 ** 13);
}
function parseEvidence(output, code, sequenceElapsedMs = null) {
  const cases = [], totals = []; let metrics = null;
  for (const line of output.split(/\r?\n/)) {
    // Read only the synthetic pipeline's closed numeric measurements. Never
    // retain raw diagnostics, execution paths/IDs, source bytes or environment.
    const diagnostic = line.match(/^\s*# (\{.*\})$/);
    if (diagnostic) {
      let row; try { row = JSON.parse(diagnostic[1]); } catch { continue; }
      if (row.case === "installed-pipeline") {
        if (metrics !== null) fail("duplicate_metrics");
        metrics = { sequenceElapsedMs, sourceBytes: row.source?.size, decodedSeconds: row.decoded?.seconds,
          preparationElapsedMs: row.prepared?.elapsedMs, preparationCpuMs: row.prepared?.metrics?.cpuMs,
          peakTreeMemoryBytes: row.prepared?.metrics?.peakTreeMemoryBytes, peakTasks: row.prepared?.metrics?.peakTasks };
        if (!validateMetrics(metrics)) fail("metrics_invalid");
      }
    }
    const match = line.match(/^\s*(?:# )?VM_INSTALLED_(CASE|TOTAL)=(\{.*\})$/);
    if (!match) continue;
    const row = JSON.parse(match[2]);
    if (match[1] === "CASE") {
      const expected = MANIFEST.cases[cases.length];
      if (!expected || Object.keys(row).sort().join(",") !== "failure,id,nativeLaunches,passed,terminationProved" || row.id !== expected.id ||
        typeof row.passed !== "boolean" || typeof row.terminationProved !== "boolean" ||
        !validateFailure(row.failure) || (row.passed ? row.failure !== null : row.failure === null) ||
        !Number.isSafeInteger(row.nativeLaunches) || row.nativeLaunches < 0 || row.nativeLaunches > expected.attempts.length) fail("case_receipt_invalid");
      cases.push(row);
    } else {
      if (Object.keys(row).sort().join(",") !== "allTerminated,attemptIds,launches" || typeof row.allTerminated !== "boolean" ||
        !Number.isSafeInteger(row.launches) || row.launches < 0 || row.launches > MANIFEST.maxLaunches ||
        !Array.isArray(row.attemptIds) || row.attemptIds.length !== row.launches ||
        row.attemptIds.some((id, i) => id !== MANIFEST.cases.flatMap(c => c.attempts)[i])) fail("total_receipt_invalid");
      totals.push(row);
    }
  }
  if (totals.length !== 1 || totals[0].launches !== cases.reduce((n, c) => n + c.nativeLaunches, 0)) fail("total_receipt_missing");
  const allPassed = code === 0 && metrics !== null && cases.length === MANIFEST.cases.length && cases.every((c, i) => c.passed && c.terminationProved && c.nativeLaunches === MANIFEST.cases[i].attempts.length);
  return { schema: 1, cases, launches: totals[0].launches, attemptIds: totals[0].attemptIds, allTerminated: totals[0].allTerminated,
    syntheticOnly: true, metrics, failure: cases.find(c => !c.passed)?.failure || null, allPassed };
}
async function writeExclusive(file, value) {
  const out = await fs.open(file, "wx", 0o600);
  try { await out.writeFile(canonical(value)); await out.sync(); } finally { await out.close(); }
  const dir = await fs.open(path.dirname(file), "r"); try { await dir.sync(); } finally { await dir.close(); }
}
async function launchSequence({ timeoutMs = MANIFEST.sequenceSeconds * 1000 } = {}) {
  const began = performance.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", MANIFEST.testFile], {
      cwd: ROOT, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/opt/ia4tube-media/runtime/usr/bin:/usr/bin:/bin", LANG: "C.UTF-8",
        CALENDAR_VM_INSTALLED_TEST: "1", CALENDAR_MEDIA_LINUX_PHYSICAL: "1", CALENDAR_MEDIA_LINUX_CGROUP_ROOT: "/sys/fs/cgroup/ia4tube-media-vm",
        CALENDAR_MEDIA_LINUX_LAUNCH_MODE: "installed", FFMPEG_TEST_BINARY: "/usr/bin/ffmpeg" } });
    let bytes = 0, output = "", failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, timeoutMs);
    const append = b => { bytes += b.length; if (bytes > 512 * 1024) { failed = true; child.kill("SIGKILL"); } else output += b.toString("utf8"); };
    child.stdout.on("data", append); child.stderr.on("data", append); child.on("error", () => { failed = true; });
    child.once("close", code => { clearTimeout(timer); resolve({ code: failed ? 1 : code, output, elapsedMs: Math.round(performance.now() - began) }); });
  });
}
async function run() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() === 0) fail("nonroot_linux_required");
  const real = await fs.realpath(__dirname); if (real !== ROOT + "/scripts/validation") fail("installed_proof_required");
  const dir = await fs.lstat(STATE); if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) fail("private_state_required");
  await writeExclusive(path.join(STATE, "intent.json"), { schema: 1, manifestSha256: sha256(canonical(MANIFEST)),
    startedAt: Date.now(), caseIds: MANIFEST.cases.map(c => c.id), attemptIds: MANIFEST.cases.flatMap(c => c.attempts), retries: 0 });
  let evidence;
  try { const result = await launchSequence(); evidence = parseEvidence(result.output, result.code, result.elapsedMs); }
  catch (error) { evidence = { schema: 1, cases: [], launches: null, attemptIds: [], allTerminated: false, syntheticOnly: true,
    metrics: null, failure: closedFailure(error, "guest-parser"), allPassed: false }; }
  await writeExclusive(path.join(STATE, "evidence.json"), evidence);
  return evidence;
}
async function collect() {
  const st = await fs.lstat(path.join(STATE, "evidence.json")); if (!st.isFile() || st.isSymbolicLink() || st.size > 32768) fail("evidence_file_invalid");
  const { allPassed, ...evidence } = JSON.parse(await fs.readFile(path.join(STATE, "evidence.json"), "utf8"));
  return evidence;
}
if (require.main === module) {
  const action = process.argv.slice(2);
  if (action.length !== 1 || !["--run", "--collect"].includes(action[0])) { process.stderr.write("VM_PROOF_GUEST=INVALID_ACTION\n"); process.exitCode = 1; }
  else (action[0] === "--run" ? run() : collect()).then(e => {
    process.stdout.write((action[0] === "--run" ? "VM_PROOF_SEQUENCE=" : "VM_PROOF_EVIDENCE=") + JSON.stringify(e) + "\n");
    if (action[0] === "--run" && (!e.allPassed || !e.allTerminated)) process.exitCode = 1;
  }).catch(() => { process.stderr.write("VM_PROOF_GUEST=CLOSED_FAILURE_NO_REPEAT\n"); process.exitCode = 1; });
}
module.exports = { parseEvidence, launchSequence, validateMetrics, closedFailure, validateFailure };
