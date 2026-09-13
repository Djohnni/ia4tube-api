"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { normalizeLinuxRuntime, launch } = require("../src/social/calendar/imports/linux-media-runtime");
const { closedSpawnErrorCode } = require("../src/social/calendar/imports/media-process-diagnostics");
const config = { cgroupRoot: "/sys/fs/cgroup/ia4tube-media-synthetic-123", launchMode: "sudo", validationOnly: true };
test("Linux runtime requires explicit isolated cgroup and validation-only mode, no loose fallback", () => {
  assert.deepEqual(normalizeLinuxRuntime(config), config);
  for (const value of [undefined, {}, { ...config, cgroupRoot: "/sys/fs/cgroup" }, { ...config, cgroupRoot: config.cgroupRoot + "/../system.slice" },
    { ...config, launchMode: "shell" }, { ...config, validationOnly: false }, { ...config, allowProcessGroups: true }]) {
    assert.throws(() => normalizeLinuxRuntime(value), /configuration_invalid/);
  }
});
test("sudo launch is an explicit fixed argv contract, not a command string or arbitrary environment", () => {
  assert.deepEqual(launch("/tmp/synthetic-native", ["--probe", config.cgroupRoot, "123"], config),
    { command: "/usr/bin/sudo", args: ["-n", "--", "/tmp/synthetic-native", "--probe", config.cgroupRoot, "123"] });
  assert.deepEqual(launch("/tmp/synthetic-native", ["--observe", "123", "1", "boot"], { ...config, launchMode: "direct" }),
    { command: "/tmp/synthetic-native", args: ["--observe", "123", "1", "boot"] });
});
test("native source retains hard fail-closed controls and Linux task count is not misrepresented as process count", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/social/calendar/imports/media-process-supervisor-linux.c"), "utf8");
  for (const marker of ["SYS_pidfd_open", "CLONE_NEWPID", "CLONE_NEWNS", "CLONE_NEWNET", "SYS_mount_setattr", "PR_SET_NO_NEW_PRIVS", "PR_CAPBSET_DROP", "cgroup.kill", "memory.max", "memory.swap.max", "pids.max", "cpu.max", ".supervision", "populated"]) assert.ok(source.includes(marker));
  assert.ok(source.includes("#define TASK_MAX 64"));
});
test("spawn diagnostic is a closed code only; unknown errors, messages and paths cannot escape", () => {
  for (const code of ["EACCES", "EPERM", "ENOENT", "EBUSY", "EAGAIN", "ENOEXEC"]) {
    assert.equal(closedSpawnErrorCode({ code, message: "private-message", path: "private-path", spawnargs: ["private-argument"] }), code);
  }
  for (const error of [null, undefined, {}, { code: 1 }, { code: "eperm" }, { code: "UNKNOWN" },
    { code: "EPERM\nprivate-message" }, { code: "C:/private/path" }, { message: "EPERM private-message" },
    { code: { toString() { throw Error("must not stringify external value"); } } }]) {
    assert.equal(closedSpawnErrorCode(error), "UNKNOWN");
  }
});
