"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { normalizeLinuxRuntime, launch, INSTALLED } = require("../src/social/calendar/imports/linux-media-runtime");
const config = { cgroupRoot: INSTALLED.cgroupRoot, launchMode: "installed", validationOnly: true };
test("installed contract accepts only fixed root and privileged installed binary", () => {
  assert.deepEqual(normalizeLinuxRuntime(config), config);
  assert.deepEqual(launch(INSTALLED.native, ["--probe"], config), { command: "/usr/bin/sudo", args: ["-n", "--", INSTALLED.native, "--probe"] });
  for (const patch of [{ cgroupRoot: "/sys/fs/cgroup/ia4tube-media-other" }, { validationOnly: false }, { runtimeRoot: "/tmp/runtime" }, { launchMode: "shell" }])
    assert.throws(() => normalizeLinuxRuntime({ ...config, ...patch }), /configuration_invalid/);
  assert.throws(() => launch("/tmp/worker-writable", [], config), /installed_launcher_invalid/);
  assert.equal(INSTALLED.quotaBytes, 3221225472);
});
test("historical Linux validation contract remains available and never becomes installed implicitly", () => {
  for (const launchMode of ["sudo", "direct"]) assert.deepEqual(normalizeLinuxRuntime({ ...config, launchMode }), { ...config, launchMode });
  assert.deepEqual(launch("/tmp/synthetic", ["--probe"], { ...config, launchMode: "direct" }), { command: "/tmp/synthetic", args: ["--probe"] });
});
test("installed native source closes high descriptors, confines reads and retains every existing hard bound", () => {
  const base = path.resolve(__dirname, "../src/social/calendar/imports");
  const native = fs.readFileSync(path.join(base, "media-process-supervisor-linux.c"), "utf8"), installed = fs.readFileSync(path.join(base, "media-process-installed-linux.h"), "utf8");
  assert.match(native, /SYS_close_range, 3U, ~0U, 0/);
  for (const value of ["memory.swap.max", "memory.oom.group", "cgroup.kill", "memory.peak", "pidfd_open", "CLONE_NEWNET", "180000", "536870912", "100000 100000"]) assert.ok(native.includes(value), value);
  for (const value of ["chroot(vm_jail)", "ia4tube-codec", "ia4tube-coordinator", "SUDO_UID", "EXT4_SUPER_MAGIC", "ST_NODEV", "3221225472ULL", "scratch.ext4", "vm_restore_fd", "vm_cleanup", "if(!empty)return -1"]) assert.ok(installed.includes(value), value);
  assert.doesNotMatch(installed, /system\(|popen\(|execvp\(/);
});
test("installation never starts a worker, carries production credentials or overwrites a prior target", () => {
  const root = path.resolve(__dirname, "../scripts/media-vm");
  const installer = fs.readFileSync(path.join(root, "install-ubuntu24.sh"), "utf8"), pack = fs.readFileSync(path.join(root, "package-install.cjs"), "utf8");
  assert.match(installer, /EXISTING_TARGET_REFUSED/); assert.match(installer, /--synthetic-proof/);
  assert.match(installer, /loop,nosuid,nodev/); assert.match(installer, /VM_WORKER_STARTED=NO/);
  assert.doesNotMatch(installer + pack, /systemctl\s+(enable|start)|NOPASSWD:\s*ALL|fs\.readFileSync\([^\n]*bridge\.key/);
  assert.match(pack, /enabled: false/); assert.match(pack, /"src", "node_modules", "workflows"/);
});
