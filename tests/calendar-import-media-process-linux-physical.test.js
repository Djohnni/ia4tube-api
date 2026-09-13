"use strict";
// Deliberately no skip: selecting this suite asserts that physical Linux proof
// is available. A missing capability fails the proof rather than turning green.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createMediaProcessExecutor } = require("../src/social/calendar/imports/media-process-executor");
const linuxRuntime = { cgroupRoot: process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT, launchMode: process.env.CALENDAR_MEDIA_LINUX_LAUNCH_MODE || "direct", validationOnly: true };
const FFMPEG = process.env.FFMPEG_TEST_BINARY;
async function fixture(t) {
  assert.equal(process.platform, "linux"); assert.ok(process.getuid() > 0, "Coordinator and PostgreSQL remain unprivileged");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ia4tube-linux-media-synthetic-"));
  t.after(async () => { const exact = await fs.realpath(root); assert.equal(path.dirname(exact), await fs.realpath(os.tmpdir())); assert.ok(path.basename(exact).startsWith("ia4tube-linux-media-synthetic-")); await fs.rm(exact, { recursive: true, force: true }); });
  const executions = path.join(root, "executions"); await fs.mkdir(executions, { mode: 0o700 });
  await fs.writeFile(path.join(executions, "other-company-art.txt"), "synthetic-preserved-peer-art", { flag: "wx", mode: 0o600 });
  const options = { workingRoot: executions, ffmpegPath: FFMPEG, allowedRoots: [], syntheticTests: true, linuxRuntime };
  const executor = createMediaProcessExecutor(options);
  assert.equal(executor.capabilities.supported, false, "Generic Linux proof is not Render production readiness");
  assert.equal(executor.capabilities.hardTermination, false);
  await executor.prepareRuntime(); assert.equal(executor.capabilities.hardTermination, true);
  return { root, executions, options, executor };
}
async function eventually(read, predicate = Boolean) { const until = Date.now() + 15000; let value; do { try { value = await read(); if (predicate(value)) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < until); assert.fail("Physical Linux condition did not settle"); }
function request(mode, timeoutMs = 10000) { return { executionId: crypto.randomUUID(), operation: "test_tree", input: { mode }, timeoutMs }; }
test("Linux physical probe, unprivileged private namespaces and immutable native control receipts", async t => {
  const f = await fixture(t), job = request("linux_containment"), result = await f.executor.run(job);
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.equal(result.result.uid, process.getuid()); assert.equal(result.result.pid, 1);
  assert.deepEqual(result.result.interfaces, ["lo"]);
  for (const key of ["requestWriteRefused", "nativeReceiptWriteRefused", "sourceWriteRefused", "otherAssetWriteRefused", "cgroupEscapeRefused"]) assert.equal(result.result[key], true, key);
  assert.equal(await fs.readFile(path.join(f.executions, "other-company-art.txt"), "utf8"), "synthetic-preserved-peer-art");
  assert.equal(result.termination.proved, true); assert.equal(result.termination.descendants, 0);
  assert.deepEqual(result.limits, { memoryBytes: 536870912, maxTasks: 64, cpuQuotaUs: 100000, cpuPeriodUs: 100000, swapBytes: 0 });
  const receipts = path.join(f.executions, job.executionId + ".supervision"); assert.deepEqual((await fs.readdir(receipts)).sort(), ["started.json", "terminal.json"]);
  t.diagnostic(JSON.stringify({ case: "linux-containment", limits: result.limits, metrics: result.metrics, elapsedMs: result.elapsedMs }));
});
test("Linux explicit child environment and lost reply replay launch exactly once", async t => {
  const f = await fixture(t), job = request("environment"); process.env.IA4TUBE_EXECUTOR_SECRET_TEST = "synthetic-private-test";
  let result; try { result = await f.executor.run(job); } finally { delete process.env.IA4TUBE_EXECUTOR_SECRET_TEST; }
  assert.equal(result.state, "succeeded", JSON.stringify(result)); assert.equal(result.result.secretAbsent, true); assert.equal(result.result.nodeOptionsAbsent, true);
  assert.deepEqual(result.result.environmentKeys, ["LANG", "LC_ALL", "TMPDIR", "UV_THREADPOOL_SIZE"]);
  assert.deepEqual(await createMediaProcessExecutor(f.options).run(job), result);
  assert.equal((await fs.readdir(f.executions)).filter(name => /^[a-f0-9-]{36}$/.test(name)).length, 1);
  await assert.rejects(f.executor.run({ ...job, input: { mode: "stall" } }), /binding_conflict/);
});
test("Linux deadline kills descendants, and concurrent second execution is refused durably", async t => {
  const f = await fixture(t), first = request("stall", 1500), running = f.executor.run(first);
  const marker = path.join(f.executions, first.executionId, "descendant.tick"); await eventually(() => fs.readFile(marker, "utf8"));
  const second = await f.executor.run(request("environment")); assert.equal(second.reason, "not_started_busy"); assert.equal(second.termination.proved, true);
  const result = await running; assert.equal(result.state, "failed"); assert.equal(result.reason, "timed_out"); assert.equal(result.termination.proved, true);
  const tick = await fs.readFile(marker, "utf8"); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await fs.readFile(marker, "utf8"), tick);
});
test("Linux creator death is observed through pidfd and descendants stop before deadline", async t => {
  const f = await fixture(t), job = request("stall", 12000), moduleName = require.resolve("../src/social/calendar/imports/media-process-executor");
  const code = `require(${JSON.stringify(moduleName)}).createMediaProcessExecutor(${JSON.stringify(f.options)}).run(${JSON.stringify(job)}).then(()=>{});`;
  const parent = spawn(process.execPath, ["-e", code], { shell: false, stdio: "ignore", env: { LANG: "C", LC_ALL: "C" } });
  const closed = new Promise(resolve => parent.once("close", resolve));
  await eventually(() => fs.readFile(path.join(f.executions, job.executionId, "descendant.tick"), "utf8")); parent.kill("SIGKILL"); await closed;
  const result = await eventually(() => f.executor.observe(job.executionId), value => value.termination?.proved);
  assert.equal(result.state, "failed"); assert.equal(result.reason, "parent_lost"); assert.ok(result.elapsedMs < 12000); assert.equal(result.termination.descendants, 0);
});
for (const mode of ["output", "finite_output"]) test(`Linux bounded discarded output: ${mode}`, async t => {
  const f = await fixture(t), result = await f.executor.run(request(mode));
  assert.equal(result.state, "failed"); assert.equal(result.reason, "output_limit"); assert.equal(result.termination.proved, true); assert.ok(result.metrics.outputBytes > 262144); assert.ok(JSON.stringify(result).length < 2500);
});
test("Linux pids controller physically rejects task pressure without escaping the cgroup", async t => {
  const f = await fixture(t), result = await f.executor.run(request("linux_task_pressure", 4000));
  assert.equal(result.state, "failed"); assert.equal(result.termination.proved, true); assert.ok(result.metrics.pidsMaxEvents > 0, JSON.stringify(result));
  assert.ok(result.metrics.peakTasks <= 64); t.diagnostic(JSON.stringify({ case: "linux-task-cap", metrics: result.metrics, limits: result.limits }));
});
test("Linux memory controller physically kills an over-budget codec tree, with no swap fallback", async t => {
  const f = await fixture(t), result = await f.executor.run(request("linux_memory_pressure", 15000));
  assert.equal(result.state, "failed"); assert.equal(result.termination.proved, true); assert.ok(result.metrics.oomKillEvents > 0, JSON.stringify(result));
  assert.equal(result.limits.memoryBytes, 536870912); assert.equal(result.limits.swapBytes, 0);
  t.diagnostic(JSON.stringify({ case: "linux-memory-cap", metrics: result.metrics, limits: result.limits }));
});
test("Linux unavailable controls fail closed before codec launch; missing receipt stays unknown", async t => {
  const f = await fixture(t), absent = createMediaProcessExecutor({ ...f.options, linuxRuntime: { ...linuxRuntime, cgroupRoot: "/sys/fs/cgroup/ia4tube-media-nonexistent-capability-test" } });
  await assert.rejects(absent.prepareRuntime(), /capabilities_unavailable/); assert.equal(absent.capabilities.hardTermination, false);
  const id = crypto.randomUUID(); assert.equal((await absent.observe(id)).state, "unknown");
});
