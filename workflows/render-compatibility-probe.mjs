// Independent start command: node workflows/render-compatibility-probe.mjs
// Register ONLY this task, not calendar-media.mjs. It cannot run a codec,
// install a privileged launcher, create/delegate a cgroup or contact an API.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_TASK_OPTIONS = Object.freeze({ name: "compatibilityProbe", plan: "flex", timeoutSeconds: 60,
  retry: Object.freeze({ maxRetries: 0 }) });
const CGROUP_BASE = "/sys/fs/cgroup";
const CGROUP_ROOT = /^\/sys\/fs\/cgroup\/ia4tube-media-[a-zA-Z0-9_-]{1,100}$/;
const MAX_READ = 131072;
const ISSUES = new Set(["PLATFORM_UNSUPPORTED", "INVALID_INPUT", "HOST_EVIDENCE_INCOMPLETE", "CGROUP_V2_NOT_OBSERVED",
  "CGROUP_MOUNT_READ_ONLY", "CGROUP_CONTROLLERS_UNAVAILABLE", "DELEGATION_NOT_CONFIGURED", "DELEGATION_CONFIGURATION_INVALID",
  "DELEGATION_NOT_AVAILABLE", "DELEGATION_UNSAFE_METADATA", "DELEGATION_CONTROLLERS_NOT_ENABLED", "COORDINATOR_MUST_BE_NONROOT"]);
const emptyChecks = () => ({ linux: false, coordinatorNonRoot: false, statusReadable: false, mountInfoReadable: false,
  cgroupV2Observed: false, cgroupMountWritableObserved: false, rootControllersReadable: false, rootControllersAvailable: false,
  effectiveSysAdmin: false, effectiveSetuid: false, effectiveSetgid: false, effectiveSetpcap: false, effectiveChown: false,
  boundingSysAdmin: false, noNewPrivilegesEnabled: false, seccompFilterObserved: false,
  delegationConfigured: false, delegationExists: false, delegationMetadataSafe: false, delegationControllersReadable: false,
  delegationControllersEnabled: false });
function result(checks, issues) {
  const closed = [...new Set(issues.map(code => ISSUES.has(code) ? code : "HOST_EVIDENCE_INCOMPLETE"))];
  return Object.freeze({ version: "V1", state: closed.length ? "CONFIGURATION_NOT_READY" : "NATIVE_PROBE_REQUIRED",
    checks: Object.freeze(checks), issues: Object.freeze(closed), physicalNativeProbeExecuted: false, launcherVerified: false,
    runtimeCompatibleProved: false, filesystemChanged: false, mediaExecuted: false, remoteCallsMade: false });
}
async function boundedText(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_READ + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_READ) throw Error("probe_read_bound");
    return buffer.toString("utf8", 0, bytesRead);
  } finally { await handle.close(); }
}
function defaultHost() {
  return { platform: process.platform, uid: process.getuid?.(), gid: process.getgid?.(),
    effectiveUid: process.geteuid?.(), effectiveGid: process.getegid?.(),
    cgroupRoot: process.env.IA4TUBE_WORKFLOW_CGROUP_ROOT,
    readText: boundedText,
    async metadata(file) {
      const stat = await fs.lstat(file), real = await fs.realpath(file);
      return { isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(), canonical: real === file,
        ownerRoot: stat.uid === 0, writableByGroupOrOther: Boolean(stat.mode & 0o022) };
    } };
}
function parseStatus(text) {
  const eff = /^CapEff:\s*([a-fA-F0-9]{1,16})\s*$/m.exec(text), bnd = /^CapBnd:\s*([a-fA-F0-9]{1,16})\s*$/m.exec(text);
  const nnp = /^NoNewPrivs:\s*([01])\s*$/m.exec(text), seccomp = /^Seccomp:\s*([012])\s*$/m.exec(text);
  if (!eff || !bnd || !nnp || !seccomp) return null;
  const effective = BigInt("0x" + eff[1]), bounding = BigInt("0x" + bnd[1]);
  return { effectiveSysAdmin: Boolean(effective & (1n << 21n)), effectiveSetuid: Boolean(effective & (1n << 7n)),
    effectiveSetgid: Boolean(effective & (1n << 6n)), effectiveSetpcap: Boolean(effective & (1n << 8n)),
    effectiveChown: Boolean(effective & 1n), boundingSysAdmin: Boolean(bounding & (1n << 21n)),
    noNewPrivilegesEnabled: nnp[1] === "1", seccompFilterObserved: seccomp[1] === "2" };
}
function parseMountInfo(text) {
  for (const line of text.split("\n")) {
    const halves = line.split(" - "); if (halves.length !== 2) continue;
    const left = halves[0].split(" "), right = halves[1].split(" ");
    if (left.length < 6 || right.length < 3 || left[4] !== CGROUP_BASE) continue;
    const mount = left[5].split(","), superblock = right[2].split(",");
    return { cgroupV2Observed: right[0] === "cgroup2",
      cgroupMountWritableObserved: mount.includes("rw") && !mount.includes("ro") && superblock.includes("rw") && !superblock.includes("ro") };
  }
  return null;
}
const controlsPresent = text => { const words = text.trim().split(/\s+/); return ["cpu", "memory", "pids"].every(v => words.includes(v)); };

// The injected host is for offline tests only. Task arguments can never choose
// paths, readers, commands, URLs, credentials or a privileged execution mode.
export async function collectCompatibility(host = defaultHost()) {
  const checks = emptyChecks(), issues = [];
  if (host.platform !== "linux") return result(checks, ["PLATFORM_UNSUPPORTED"]);
  checks.linux = true;
  checks.coordinatorNonRoot = [host.uid, host.gid, host.effectiveUid, host.effectiveGid].every(value => Number.isInteger(value) && value > 0);
  if (!checks.coordinatorNonRoot) issues.push("COORDINATOR_MUST_BE_NONROOT");
  async function read(file) {
    try { const value = await host.readText(file); return typeof value === "string" && Buffer.byteLength(value) <= MAX_READ ? value : null; }
    catch (_) { return null; }
  }
  const [statusText, mountText, controllerText] = await Promise.all([
    read("/proc/self/status"), read("/proc/self/mountinfo"), read(CGROUP_BASE + "/cgroup.controllers")
  ]);
  const status = statusText === null ? null : parseStatus(statusText), mounts = mountText === null ? null : parseMountInfo(mountText);
  checks.statusReadable = Boolean(status); checks.mountInfoReadable = Boolean(mounts);
  if (status) Object.assign(checks, status); else issues.push("HOST_EVIDENCE_INCOMPLETE");
  if (mounts) Object.assign(checks, mounts); else issues.push("HOST_EVIDENCE_INCOMPLETE");
  if (!checks.cgroupV2Observed) issues.push("CGROUP_V2_NOT_OBSERVED");
  if (mounts && !checks.cgroupMountWritableObserved) issues.push("CGROUP_MOUNT_READ_ONLY");
  checks.rootControllersReadable = controllerText !== null;
  checks.rootControllersAvailable = controllerText !== null && controlsPresent(controllerText);
  if (!checks.rootControllersReadable) issues.push("HOST_EVIDENCE_INCOMPLETE");
  else if (!checks.rootControllersAvailable) issues.push("CGROUP_CONTROLLERS_UNAVAILABLE");
  if (host.cgroupRoot === undefined || host.cgroupRoot === "") issues.push("DELEGATION_NOT_CONFIGURED");
  else if (typeof host.cgroupRoot !== "string" || !CGROUP_ROOT.test(host.cgroupRoot)) issues.push("DELEGATION_CONFIGURATION_INVALID");
  else {
    checks.delegationConfigured = true;
    let metadata;
    try { metadata = await host.metadata(host.cgroupRoot); } catch (_) {}
    checks.delegationExists = Boolean(metadata);
    checks.delegationMetadataSafe = Boolean(metadata?.isDirectory && !metadata.isSymbolicLink && metadata.canonical &&
      metadata.ownerRoot && !metadata.writableByGroupOrOther);
    if (!checks.delegationExists) issues.push("DELEGATION_NOT_AVAILABLE");
    else if (!checks.delegationMetadataSafe) issues.push("DELEGATION_UNSAFE_METADATA");
    // Never follow a rejected link or inspect data under an unsafe directory.
    if (checks.delegationMetadataSafe) {
      const delegated = await read(host.cgroupRoot + "/cgroup.subtree_control");
      checks.delegationControllersReadable = delegated !== null;
      checks.delegationControllersEnabled = delegated !== null && controlsPresent(delegated);
      if (delegated === null) issues.push("HOST_EVIDENCE_INCOMPLETE");
      else if (!checks.delegationControllersEnabled) issues.push("DELEGATION_CONTROLLERS_NOT_ENABLED");
    }
  }
  // Even all-positive readings cannot prove syscall permissions, a privileged
  // launcher, process-tree termination or Render's host guarantees. Existing
  // media-process-supervisor-linux --probe is reusable later without codecs,
  // but needs separately prepared delegation and a privileged launcher with a
  // non-root parent. This read-only task never supplies those privileges.
  return result(checks, issues);
}
export function registerCompatibilityProbe(registerTask, collect = collectCompatibility) {
  return registerTask(PROBE_TASK_OPTIONS, async (_context, ...inputs) => {
    if (inputs.length !== 0) return result(emptyChecks(), ["INVALID_INPUT"]);
    try { return await collect(); } catch (_) { return result(emptyChecks(), ["HOST_EVIDENCE_INCOMPLETE"]); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No SDK import/registration when an offline test imports this module.
  const { task } = await import("@renderinc/sdk/workflows");
  registerCompatibilityProbe(task);
}
