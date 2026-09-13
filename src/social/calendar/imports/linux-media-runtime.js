"use strict";
// Linux-only capability layer. A configured host is not a validated host:
// prepareRuntime physically exercises the mandatory native isolation first.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const OUTPUT_MAX = 262144;
const INSTALLED = Object.freeze({ root: "/opt/ia4tube-media", native: "/opt/ia4tube-media/bin/supervisor",
  node: "/opt/ia4tube-media/runtime/usr/bin/node", entry: "/opt/ia4tube-media/runtime/app/src/social/calendar/imports/media-process-child.js",
  ffmpeg: "/opt/ia4tube-media/runtime/usr/bin/ffmpeg", cgroupRoot: "/sys/fs/cgroup/ia4tube-media-vm",
  workRoot: "/var/lib/ia4tube-media/work", executionRoot: "/var/lib/ia4tube-media/work/executions", quotaBytes: 3 * 1024 ** 3 });
function fail(code) { throw Object.assign(new Error("media_process_linux_" + code), { code: "media_process_linux_" + code }); }
function normalizeLinuxRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["cgroupRoot", "launchMode", "validationOnly"].includes(key)) ||
      !/^\/sys\/fs\/cgroup\/ia4tube-media-[a-zA-Z0-9_-]{1,100}$/.test(value.cgroupRoot || "") ||
      !["direct", "sudo", "installed"].includes(value.launchMode) || value.validationOnly !== true ||
      value.launchMode === "installed" && value.cgroupRoot !== INSTALLED.cgroupRoot) fail("configuration_invalid");
  return Object.freeze({ cgroupRoot: value.cgroupRoot, launchMode: value.launchMode, validationOnly: true });
}
function launch(native, args, config) {
  if (config.launchMode === "installed" && native !== INSTALLED.native) fail("installed_launcher_invalid");
  return ["sudo", "installed"].includes(config.launchMode) ? { command: "/usr/bin/sudo", args: ["-n", "--", native, ...args] } : { command: native, args };
}
async function installedSupervisor() {
  async function immutable(name, directory = false) {
    const parts = name.split("/").filter(Boolean); let current = "";
    for (const part of parts) { current += "/" + part; const st = await fs.lstat(current);
      if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail("installed_path_invalid"); }
    const st = await fs.stat(name);
    if (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1 || (st.mode & 0o222)) fail("installed_path_invalid");
  }
  await immutable(INSTALLED.root, true); await immutable(INSTALLED.native); await immutable(INSTALLED.node); await immutable(INSTALLED.entry);
  const recordPath = INSTALLED.root + "/installation.json"; await immutable(recordPath);
  if ((await fs.stat(recordPath)).size > 4096) fail("installed_record_invalid");
  const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
  const sha = async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  const sources = await Promise.all(["media-process-supervisor-linux.c", "media-process-installed-linux.h"].map(name => fs.readFile(path.join(__dirname, name))));
  if (record.schema !== 1 || record.sourceSha256 !== crypto.createHash("sha256").update(Buffer.concat(sources)).digest("hex") ||
      record.binarySha256 !== await sha(INSTALLED.native) || record.entrySha256 !== await sha(INSTALLED.entry) ||
      record.entrySha256 !== await sha(path.join(__dirname, "media-process-child.js")) || record.aggregateScratchQuotaBytes !== INSTALLED.quotaBytes ||
      record.coordinatorUid < 1 || record.codecUid < 1 || record.coordinatorUid === record.codecUid || record.coordinatorUid !== process.getuid()) fail("installed_record_invalid");
  return INSTALLED.native;
}
async function bounded(command, args, { env, cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, output = 0, bad = false;
    try { child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env }); }
    catch { reject(Object.assign(new Error("media_process_linux_launch_failed"), { code: "media_process_linux_launch_failed" })); return; }
    const timer = setTimeout(() => { bad = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", () => { bad = true; });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { output += chunk.length; if (output > OUTPUT_MAX) { bad = true; child.kill("SIGKILL"); } });
    child.once("close", code => { clearTimeout(timer); resolve({ code, valid: !bad && code === 0 }); });
  });
}
async function compileLinuxSupervisor(root, { safePath, cleanEnvironment, linuxRuntime } = {}) {
  if (linuxRuntime?.launchMode === "installed") return installedSupervisor();
  const source = path.join(__dirname, "media-process-supervisor-linux.c");
  const hash = crypto.createHash("sha256").update(await fs.readFile(source)).digest("hex");
  const destination = path.join(root, `supervisor-${hash}.linux`);
  async function verifyPublished() {
    await safePath(destination, { file: true }); await safePath(destination + ".json", { file: true });
    const stat = await fs.stat(destination), recordStat = await fs.stat(destination + ".json");
    if ((stat.mode & 0o222) || (recordStat.mode & 0o222) || recordStat.size > 1024) fail("supervisor_invalid");
    const record = JSON.parse(await fs.readFile(destination + ".json", "utf8"));
    const actual = crypto.createHash("sha256").update(await fs.readFile(destination)).digest("hex");
    if (record.schema !== 1 || record.sourceSha256 !== hash || record.binarySha256 !== actual) fail("supervisor_invalid");
    return destination;
  }
  try { await fs.lstat(destination); return await verifyPublished(); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Existing binary with a missing receipt is not permission to overwrite it.
    try { await fs.lstat(destination); fail("supervisor_invalid"); } catch (missing) { if (missing.code !== "ENOENT") throw missing; }
  }
  // Fixed compiler from this host, never a request-controlled program or flag.
  const compiler = await fs.realpath("/usr/bin/cc"), stat = await fs.stat(compiler);
  if (!stat.isFile() || !compiler.startsWith("/usr/bin/") || stat.uid !== 0 || (stat.mode & 0o022)) fail("compiler_invalid");
  const temporary = path.join(root, `compile-${crypto.randomUUID()}.linux`);
  // GCC's assembler/linker are subprocesses resolved via PATH. This fixed
  // system-only compiler PATH is deliberately NOT passed to any media child.
  const result = await bounded(compiler, ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-misleading-indentation", "-D_FORTIFY_SOURCE=2", "-fstack-protector-strong", "-o", temporary, source],
    { cwd: root, env: { ...cleanEnvironment(root), PATH: "/usr/bin:/bin" } });
  if (!result.valid) fail("compiler_failed");
  await safePath(temporary, { file: true }); await fs.chmod(temporary, 0o500);
  try { await fs.link(temporary, destination); } catch (error) { if (error.code !== "EEXIST") throw error; await safePath(destination, { file: true }); }
  await fs.unlink(temporary);
  const record = { schema: 1, sourceSha256: hash, binarySha256: crypto.createHash("sha256").update(await fs.readFile(destination)).digest("hex") };
  const receipt = await fs.open(destination + ".json", "wx", 0o400);
  try { await receipt.writeFile(JSON.stringify(record)); await receipt.sync(); } finally { await receipt.close(); }
  return verifyPublished();
}
async function probeLinuxRuntime(native, config, cleanEnvironment, root) {
  const request = launch(native, ["--probe", config.cgroupRoot, String(process.pid)], config);
  const result = await bounded(request.command, request.args, { cwd: root, env: cleanEnvironment(root), timeoutMs: 15000 });
  if (!result.valid) fail("capabilities_unavailable");
  return Object.freeze({ platform: "linux", validationOnly: true, cgroupV2: true, pidfd: true, privatePidMountNetworkNamespaces: true,
    unprivilegedCodec: true, readOnlyHostFilesystem: config.launchMode !== "installed", writableTaskRootsOnly: true,
    ...(config.launchMode === "installed" ? { readIsolatedRoot: true, distinctCodecUid: true,
      aggregateScratchQuotaBytes: INSTALLED.quotaBytes, installedLauncher: true } : {}),
    maxTasks: 64, cpuQuotaUs: 100000, cpuPeriodUs: 100000, memorySwapBytes: 0 });
}
module.exports = { normalizeLinuxRuntime, compileLinuxSupervisor, probeLinuxRuntime, launch, INSTALLED };
