"use strict";
// Trusted one-time root installation only. Source is a reviewed, sanitized
// package. No credentials, git metadata, user media or output evidence copied.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const target = "/opt/ia4tube-media", source = path.resolve(__dirname, "../.."), runtime = target + "/runtime";
const diagnostic = require("./install-diagnostics.cjs").productionSession();
const { createFixedFile } = require("./install-file.cjs");
const operation = (id, fn) => diagnostic.span(id, "scripts/media-vm/package-install.cjs#" + id, fn);
function fail() { throw Error("vm_installation_refused"); }
function main() {
if (process.platform !== "linux" || process.getuid() !== 0 || process.version !== "v24.15.0" ||
    process.argv.length > 3 || process.argv[2] && process.argv[2] !== "--seal") fail();
function newFile(name, value, mode = 0o444) { return operation("create_" + path.basename(name).replace(/[^a-z0-9_-]/g,"_").slice(0,50), () => createFixedFile(name,value,mode)); }
function mkdir(name) { fs.mkdirSync(name, { recursive: true, mode: 0o755 }); }
function copyFile(from, to) { mkdir(path.dirname(to)); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chownSync(to, 0, 0); fs.chmodSync(to, 0o555); }
function readonlyTree(name) {
  const st = fs.lstatSync(name); if (st.isSymbolicLink()) fail();
  if (st.isDirectory()) { for (const child of fs.readdirSync(name)) readonlyTree(path.join(name, child)); fs.chmodSync(name, 0o555); }
  else if (st.isFile()) fs.chmodSync(name, st.mode & 0o111 ? 0o555 : 0o444); else fail();
  fs.chownSync(name, 0, 0);
}
const coordinatorUid = operation("coordinator_uid", () => Number(execFileSync("/usr/bin/id", ["-u", "ia4tube-coordinator"], { encoding: "utf8" }).trim()));
const coordinatorGid = operation("coordinator_gid", () => Number(execFileSync("/usr/bin/id", ["-g", "ia4tube-coordinator"], { encoding: "utf8" }).trim()));
const codecUid = operation("codec_uid", () => Number(execFileSync("/usr/bin/id", ["-u", "ia4tube-codec"], { encoding: "utf8" }).trim()));
if (!coordinatorUid || !codecUid || coordinatorUid === codecUid) fail();
const sha = filename => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
if (process.argv[2] === "--seal") {
  const parts = ["media-process-supervisor-linux.c", "media-process-installed-linux.h"].map(name => fs.readFileSync(path.join(source, "src/social/calendar/imports", name)));
  const content = crypto.createHash("sha256");
  function inventory(name) { const st = fs.lstatSync(name); if (st.isSymbolicLink()) fail();
    if (st.isDirectory()) for (const child of fs.readdirSync(name).sort()) inventory(path.join(name, child));
    else if (st.isFile()) content.update(path.relative(runtime, name)).update("\0").update(sha(name)).update("\n"); else fail(); }
  inventory(runtime); content.update(sha(target + "/bin/supervisor")); const runtimeRevision = content.digest("hex");
  newFile(target + "/installation.json", JSON.stringify({ schema: 1, sourceSha256: crypto.createHash("sha256").update(Buffer.concat(parts)).digest("hex"),
    binarySha256: sha(target + "/bin/supervisor"), entrySha256: sha(runtime + "/app/src/social/calendar/imports/media-process-child.js"),
    runtimeRevision, coordinatorUid, codecUid, aggregateScratchQuotaBytes: 3221225472, validationOnly: true }));
  const configFile = "/etc/ia4tube-media/worker.json", config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.runtimeRevision = runtimeRevision; fs.writeFileSync(configFile, JSON.stringify(config));
  return;
}
for (const area of ["runtime", "coordinator", "proof"]) { if (fs.existsSync(target + "/" + area)) fail(); mkdir(target + "/" + area); }
const binaries = [[process.execPath, "/usr/bin/node"], ["/usr/bin/ffmpeg", "/usr/bin/ffmpeg"], ["/usr/bin/ffprobe", "/usr/bin/ffprobe"]];
const libraries = new Set();
for (const [binary, destination] of binaries) {
  const resolved = fs.realpathSync(binary), st = fs.statSync(resolved); if (!st.isFile() || st.uid !== 0 || st.mode & 0o022) fail();
  copyFile(resolved, runtime + destination);
  const listing = operation("dependencies_" + path.basename(destination), () => execFileSync("/usr/bin/ldd", [resolved], { encoding: "utf8", timeout: 10000, maxBuffer: 65536,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }));
  for (const match of listing.matchAll(/(?:=>\s*)?(\/(?:usr\/)?lib[^\s]*)\s+\(/g)) libraries.add(match[1]);
}
operation("copy_libraries", () => { for (const library of libraries) if (!fs.existsSync(runtime + library)) copyFile(fs.realpathSync(library), runtime + library); });
for (const appRoot of [runtime + "/app", target + "/coordinator", target + "/proof"]) {
  mkdir(appRoot);
  for (const name of ["src", "node_modules", "workflows"]) operation("copy_" + path.basename(appRoot) + "_" + name, () => fs.cpSync(path.join(source, name), path.join(appRoot, name), {
    recursive: true, errorOnExist: true, force: false, dereference: true,
    filter: from => !from.split(path.sep).includes(".bin") }));
  for (const name of ["package.json", "package-lock.json"]) copyFile(path.join(source, name), path.join(appRoot, name));
}
for (const area of ["tests", "scripts", "db"]) operation("copy_proof_"+area, () => fs.cpSync(path.join(source, area), target + "/proof/"+area, { recursive: true, errorOnExist: true, force: false, dereference: true }));
for (const name of [runtime, target + "/coordinator", target + "/proof"]) operation("seal_tree_"+path.basename(name), () => readonlyTree(name));
copyFile(path.join(source, "scripts/media-vm/prepare-cgroup.sh"), target + "/bin/prepare-cgroup");
newFile("/etc/sudoers.d/ia4tube-media", "# One installed launcher; its native parser enforces fixed targets and caller identity.\n" +
  "Defaults:ia4tube-coordinator !requiretty\n" +
  "ia4tube-coordinator ALL=(root) NOPASSWD: /opt/ia4tube-media/bin/supervisor\n", 0o440);
newFile("/etc/ia4tube-media/worker.json", JSON.stringify({ schema: 1, enabled: false, workerId: crypto.randomUUID(),
  runtimeRevision: sha(path.join(source, "src/social/calendar/imports/media-process-supervisor-linux.c")),
  apiOrigin: "https://ia4tube-api.onrender.com", stateRoot: "/var/lib/ia4tube-media/state", workRoot: "/var/lib/ia4tube-media/work/data",
  executorRoot: "/var/lib/ia4tube-media/work/executions", ffmpegPath: runtime + "/usr/bin/ffmpeg",
  linuxRuntime: { cgroupRoot: "/sys/fs/cgroup/ia4tube-media-vm", launchMode: "installed", validationOnly: true }, pollIntervalMs: 5000 }), 0o440);
fs.chownSync("/etc/ia4tube-media/worker.json", 0, coordinatorGid);
newFile("/etc/ia4tube-media/synthetic-coordinator-secret", "synthetic-only-not-a-credential", 0o440);
fs.chownSync("/etc/ia4tube-media/synthetic-coordinator-secret", 0, coordinatorGid);
newFile("/var/tmp/ia4tube-synthetic-outside-readable.txt", "synthetic-public-readable-host-file", 0o444);
newFile("/etc/systemd/system/ia4tube-media-worker.service", "[Unit]\nDescription=iA4tube media coordinator (disabled candidate)\nAfter=network-online.target ia4tube-media-containment.service\nRequires=ia4tube-media-containment.service\nRequiresMountsFor=/var/lib/ia4tube-media/work\n\n[Service]\nType=simple\nUser=ia4tube-coordinator\nGroup=ia4tube-coordinator\nWorkingDirectory=/opt/ia4tube-media/coordinator\nExecStart=/opt/ia4tube-media/runtime/usr/bin/node /opt/ia4tube-media/coordinator/workflows/calendar-media-vm.cjs\nRestart=no\nTimeoutStopSec=240s\nKillMode=process\nUMask=0077\nLimitCORE=0\n\n[Install]\nWantedBy=multi-user.target\n", 0o444);
// Boot only prepares an empty bounded filesystem/cgroup; no worker is enabled.
const mountUnit = "var-lib-ia4tube\\x2dmedia-work.mount";
newFile("/etc/systemd/system/" + mountUnit, "[Unit]\nDescription=iA4tube fixed scratch block device\nBefore=ia4tube-media-containment.service\n\n[Mount]\nWhat=/var/lib/ia4tube-media/scratch.ext4\nWhere=/var/lib/ia4tube-media/work\nType=ext4\nOptions=loop,nosuid,nodev\n\n[Install]\nWantedBy=local-fs.target\n", 0o444);
newFile("/etc/systemd/system/ia4tube-media-containment.service", "[Unit]\nDescription=iA4tube empty cgroup preparation\nAfter=" + mountUnit + "\nRequires=" + mountUnit + "\n\n[Service]\nType=oneshot\nExecStart=/opt/ia4tube-media/bin/prepare-cgroup\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n", 0o444);
mkdir("/etc/systemd/system/local-fs.target.wants"); mkdir("/etc/systemd/system/multi-user.target.wants");
fs.symlinkSync("../" + mountUnit, "/etc/systemd/system/local-fs.target.wants/" + mountUnit);
fs.symlinkSync("../ia4tube-media-containment.service", "/etc/systemd/system/multi-user.target.wants/ia4tube-media-containment.service");
}
try { operation(process.argv[2] === "--seal" ? "seal_package" : "copy_package", main); }
catch (error) { process.stderr.write("VM_INSTALL_INTERNAL=FAILED\n"); process.exitCode = Number.isInteger(error.status) && error.status > 0 && error.status <= 255 ? error.status : 1; }
