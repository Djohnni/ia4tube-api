"use strict";

// Synthetic-only CI entrypoint. Never accepts a production URL, arbitrary test
// name or credential. Evidence is bounded text; no media/artifact upload.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

assert.equal(process.platform, "linux");
assert.equal(process.env.CALENDAR_MEDIA_LINUX_PHYSICAL, "1");
assert.match(process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT || "", /^\/sys\/fs\/cgroup\/ia4tube-media-synthetic-\d+-\d+$/);
assert.equal(typeof process.getuid(), "number");
assert.notEqual(process.getuid(), 0, "Coordinator and synthetic PostgreSQL must not run as root");
assert.equal(process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN, "/usr/lib/postgresql/16/bin");
assert.equal(process.env.FFMPEG_TEST_BINARY, "/usr/bin/ffmpeg");
const fixedVersion = (program, args) => {
  const r = spawnSync(program, args, { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
  assert.equal(r.status, 0, "Required installed test tool unavailable");
  return r.stdout.split("\n")[0].slice(0,200);
};
console.log("LINUX_SYNTHETIC_ENV=" + JSON.stringify({
  platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version,
  uid: process.getuid(), cgroupV2: fs.existsSync("/sys/fs/cgroup/cgroup.controllers"),
  postgres: fixedVersion("/usr/lib/postgresql/16/bin/postgres", ["--version"]),
  ffmpeg: fixedVersion("/usr/bin/ffmpeg", ["-version"]),
  gcc: fixedVersion("/usr/bin/gcc", ["--version"]),
  externalProvider: "simulated", renderTasksStarted: 0, realMediaUsed: false
}));

// Final list is deliberately explicit, not a wildcard over unrelated or remote
// tests. Every required test must exist; missing tests are a failed proof.
const tests = [
  "tests/calendar-import-media-linux-contract.test.js",
  "tests/calendar-import-media-process-linux-physical.test.js",
  "tests/calendar-import-media-linux-candidate-limit-physical.test.js",
  "tests/calendar-import-operational-pipeline-physical.test.js",
  "tests/calendar-import-operational-result-recovery-physical.test.js",
  "tests/calendar-import-operational-runner-fencing-physical.test.js",
  "tests/calendar-import-operational-prelaunch-physical.test.js",
  "tests/calendar-operational-media-e2e.test.js",
  "tests/calendar-import-retention-policy.test.js",
  "tests/calendar-import-retention-postgres-physical.test.js"
];
for (const file of tests) assert.ok(fs.statSync(path.resolve(file)).isFile());
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...tests],
  { shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let total = 0, output = "", exceeded = false;
const collect = chunk => {
  total += chunk.length;
  if (total > 4 * 1024 * 1024) { exceeded = true; child.kill("SIGTERM"); return; }
  output += chunk.toString("utf8");
};
child.stdout.on("data", collect); child.stderr.on("data", collect);
child.on("error", () => { console.error("LINUX_PROOF_LAUNCH_FAILED"); process.exitCode = 1; });
child.on("close", code => {
  if (exceeded) { console.error("LINUX_PROOF_OUTPUT_LIMIT_EXCEEDED"); process.exitCode = 1; return; }
  process.stdout.write(output);
  const summary = field => Number(output.match(new RegExp("^# " + field + " (\\d+)$", "m"))?.[1] ?? NaN);
  const complete = code === 0 && summary("tests") > 0 && summary("fail") === 0 &&
    summary("cancelled") === 0 && summary("skipped") === 0 && summary("todo") === 0;
  console.log("LINUX_SYNTHETIC_COMPLETE=" + (complete ? "YES" : "NO"));
  process.exitCode = complete ? 0 : 1;
});
