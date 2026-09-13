"use strict";

// Focal regressions for the VM adapter only. No remote provider or real media.
const assert = require("node:assert/strict");
const fs = require("node:fs"), { spawn } = require("node:child_process");
assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.CALENDAR_MEDIA_LINUX_PHYSICAL, "1");
assert.equal(process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN, "/usr/lib/postgresql/16/bin");
assert.match(process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT || "", /^\/sys\/fs\/cgroup\/ia4tube-media-vm-synthetic-\d+-\d+$/);
const tests = [
  "tests/calendar-vm-transport.test.js",
  "tests/calendar-vm-proof-controller.test.js",
  "tests/calendar-vm-proof-offline.test.js",
  "tests/calendar-vm-private-physical.test.js",
  "tests/calendar-import-media-linux-contract.test.js",
  "tests/calendar-import-media-installed-contract.test.js",
  "tests/calendar-import-media-process-linux-physical.test.js",
  "tests/calendar-render-workflow-adapter.test.js",
  "tests/calendar-workflow-private-physical.test.js"
];
for (const file of tests) assert.ok(fs.statSync(file).isFile());
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...tests],
  { shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let total = 0, output = "", exceeded = false;
const collect = chunk => {
  total += chunk.length;
  if (total > 4 * 1024 * 1024) { exceeded = true; child.kill("SIGTERM"); return; }
  output += chunk.toString("utf8");
};
child.stdout.on("data", collect); child.stderr.on("data", collect);
child.on("error", () => { process.stderr.write("VM_SYNTHETIC_LAUNCH_FAILED\n"); process.exitCode = 1; });
child.on("close", code => {
  if (exceeded) { process.stderr.write("VM_SYNTHETIC_OUTPUT_LIMIT\n"); process.exitCode = 1; return; }
  process.stdout.write(output);
  const count = name => Number(output.match(new RegExp("^# " + name + " (\\d+)$", "m"))?.[1] ?? NaN);
  const complete = code === 0 && count("tests") > 0 && ["fail", "cancelled", "skipped", "todo"].every(k => count(k) === 0);
  process.stdout.write("VM_SYNTHETIC_COMPLETE=" + (complete ? "YES" : "NO") + "\n");
  process.exitCode = complete ? 0 : 1;
});
