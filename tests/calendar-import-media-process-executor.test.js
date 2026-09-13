"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), { spawn } = require("node:child_process");
const { createMediaProcessExecutor } = require("../src/social/calendar/imports/media-process-executor");
const { createProcessDiskInspectionWorker } = require("../src/social/calendar/imports/process-disk-inspection-worker");
const FFMPEG = path.resolve(__dirname, "../../video_audit/pydeps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"), hash = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t, syntheticTests = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-real-process-test-"));
  t.after(async () => { const exact = await fs.realpath(root); assert.equal(path.dirname(exact), await fs.realpath(os.tmpdir())); assert.ok(path.basename(exact).startsWith("iA4tube-real-process-test-")); await fs.rm(exact, { recursive: true, force: true }); });
  const executionRoot = path.join(root, "executions"), staging = path.join(root, "staging"), output = path.join(root, "output");
  for (const dir of [executionRoot, staging, output]) await fs.mkdir(dir, { mode: 0o700 });
  const options = { workingRoot: executionRoot, ffmpegPath: FFMPEG, allowedRoots: [staging, output], syntheticTests };
  return { root, executionRoot, staging, output, options, executor: createMediaProcessExecutor(options) };
}
async function eventually(read, predicate = Boolean) { const until = Date.now() + 10000; let value; do { try { value = await read(); if (predicate(value)) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < until); assert.fail("physical process condition did not settle"); }
test("real child has only explicit environment and receipt is replayable without a second launch", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t); process.env.IA4TUBE_EXECUTOR_SECRET_TEST = "synthetic-do-not-inherit";
  const executionId = crypto.randomUUID(), request = { executionId, operation: "test_tree", input: { mode: "environment" }, timeoutMs: 5000 };
  let result; try { result = await f.executor.run(request); } finally { delete process.env.IA4TUBE_EXECUTOR_SECRET_TEST; }
  assert.equal(result.state, "succeeded"); assert.equal(result.result.secretAbsent, true); assert.equal(result.result.nodeOptionsAbsent, true);
  assert.deepEqual(result.result.environmentKeys, ["SystemRoot", "TEMP", "TMP", "UV_THREADPOOL_SIZE"]); assert.notEqual(result.result.pid, process.pid);
  assert.equal(result.termination.proved, true); assert.equal(result.termination.descendants, 0); assert.match(result.termination.proofId, /^[a-f0-9]{64}$/);
  assert.ok(result.metrics.peakTreeMemoryBytes > 0); assert.ok(result.metrics.cpuMs > 0);
  assert.deepEqual(await createMediaProcessExecutor(f.options).run(request), result);
  assert.equal((await fs.readdir(f.executionRoot)).filter(name => /^[a-f0-9-]{36}$/.test(name)).length, 1);
  await assert.rejects(f.executor.run({ ...request, input: { mode: "stall" } }), /binding_conflict/);
  t.diagnostic(JSON.stringify({ case: "real-node-child", metrics: result.metrics, elapsedMs: result.elapsedMs }));
});
for (const mode of ["stall", "child_exit"]) test(`native deadline kills complete tree: ${mode}`, { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), executionId = crypto.randomUUID();
  await f.executor.prepareRuntime(); // prove actual tree death, not budget spent compiling before launch
  const result = await f.executor.run({ executionId, operation: "test_tree", input: { mode }, timeoutMs: 700 });
  assert.equal(result.state, "failed"); assert.equal(result.reason, "timed_out"); assert.equal(result.termination.proved, true); assert.equal(result.termination.descendants, 0);
  const marker = path.join(f.executionRoot, executionId, "descendant.tick"), previous = await fs.readFile(marker, "utf8");
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await fs.readFile(marker, "utf8"), previous);
  t.diagnostic(JSON.stringify({ case: mode, metrics: result.metrics, elapsedMs: result.elapsedMs }));
});
test("parent death terminates assigned descendants and leaves a recoverable terminal proof", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), executionId = crypto.randomUUID(), modulePath = require.resolve("../src/social/calendar/imports/media-process-executor");
  const code = `require(${JSON.stringify(modulePath)}).createMediaProcessExecutor(${JSON.stringify(f.options)}).run(${JSON.stringify({ executionId, operation: "test_tree", input: { mode: "stall" }, timeoutMs: 10000 })}).then(()=>{});`;
  const parent = spawn(process.execPath, ["-e", code], { windowsHide: true, shell: false, stdio: "ignore" });
  const closed = new Promise(resolve => parent.once("close", resolve));
  await eventually(() => fs.readFile(path.join(f.executionRoot, executionId, "descendant.tick"), "utf8"));
  parent.kill("SIGKILL"); await closed;
  const result = await eventually(() => f.executor.observe(executionId), value => value.termination?.proved);
  assert.equal(result.state, "failed"); assert.equal(result.reason, "parent_lost"); assert.equal(result.termination.descendants, 0);
  assert.ok(result.elapsedMs < 10000);
});
test("stdout flood is bounded and never copied into a result or error", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), executionId = crypto.randomUUID(), result = await f.executor.run({ executionId, operation: "test_tree", input: { mode: "output" }, timeoutMs: 5000 });
  assert.equal(result.state, "failed"); assert.equal(result.reason, "output_limit"); assert.equal(result.termination.proved, true);
  assert.ok(result.metrics.outputBytes > 262144); assert.ok(JSON.stringify(result).length < 2000);
});
test("finite output burst cannot become successful merely because the child already exited", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), result = await f.executor.run({ executionId: crypto.randomUUID(), operation: "test_tree", input: { mode: "finite_output" }, timeoutMs: 5000 });
  assert.equal(result.state, "failed"); assert.equal(result.reason, "output_limit"); assert.equal(result.termination.proved, true); assert.equal(result.termination.descendants, 0);
  assert.ok(result.metrics.outputBytes > 262144);
});
test("repeated fresh compile and immediate spawn use a published executable, without launch retries", { skip: process.platform !== "win32" }, async t => {
  for (let index = 0; index < 8; index++) {
    const f = await fixture(t), executionId = crypto.randomUUID(), result = await f.executor.run({ executionId, operation: "test_tree", input: { mode: "environment" }, timeoutMs: 5000 });
    assert.equal(result.state, "succeeded", `iteration ${index}: ${JSON.stringify(result)}`);
    const attempts = (await fs.readdir(f.executionRoot)).filter(name => /^[a-f0-9-]{36}$/.test(name)); assert.deepEqual(attempts, [executionId]);
  }
});
for (const stage of ["compile", "spawn"]) test(`known ${stage} failure gets durable no-launch proof; missing receipt still does not`, { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), source = await fs.readFile(path.join(__dirname, "../src/social/calendar/imports/media-process-supervisor.cs")), executable = path.join(f.executionRoot, `supervisor-${hash(source)}.exe`);
  if (stage === "compile") await fs.mkdir(executable); // exact synthetic unsafe-cache condition, before any launch
  else await fs.writeFile(executable, "synthetic invalid PE executable", { flag: "wx" }); // real CreateProcess rejection
  const executionId = crypto.randomUUID(), result = await f.executor.run({ executionId, operation: "test_tree", input: { mode: "environment" }, timeoutMs: 5000 });
  assert.equal(result.state, "failed"); assert.equal(result.reason, `not_started_${stage}`); assert.equal(result.termination.proved, true);
  assert.deepEqual(await createMediaProcessExecutor(f.options).observe(executionId), result);
  const names = await fs.readdir(path.join(f.executionRoot, executionId)); assert.equal(names.includes("started.json"), false); assert.equal(names.includes("terminal.json"), false);
  assert.ok(names.includes("launcher-terminal.json"));
  assert.equal((await f.executor.observe(crypto.randomUUID())).state, "unknown");
});
test("compiler time consumes execution budget and an exhausted prelaunch budget never starts a worker", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), executionId = crypto.randomUUID(), request = { executionId, operation: "test_tree", input: { mode: "stall" }, timeoutMs: 1 };
  const result = await f.executor.run(request); assert.equal(result.state, "failed"); assert.equal(result.reason, "not_started_deadline"); assert.equal(result.termination.proved, true);
  const names = await fs.readdir(path.join(f.executionRoot, executionId)); assert.equal(names.includes("started.json"), false); assert.equal(names.includes("terminal.json"), false);
  assert.deepEqual(await createMediaProcessExecutor(f.options).run(request), result);
});
test("absent launch receipt never fabricates no-process proof or relaunches", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), executionId = crypto.randomUUID();
  assert.deepEqual(await f.executor.observe(executionId), { state: "unknown", executionId, reason: "receipt_missing" });
  assert.equal((await fs.readdir(f.executionRoot)).length, 0);
  await assert.rejects(f.executor.run({ executionId, operation: "arbitrary_command", input: { command: "ignored" } }), /operation_forbidden/);
  const productionShape = createMediaProcessExecutor({ ...f.options, syntheticTests: false });
  await assert.rejects(productionShape.run({ executionId, operation: "test_tree", input: { mode: "stall" } }), /operation_forbidden/);
});
function inspectionTask(bytes, kind = "image") { const ticketId = crypto.randomUUID(), now = Date.now(); return { schema: 1, kind: "inspect_import", providerType: "render_disk", companyId: crypto.randomUUID(), userId: crypto.randomUUID(), ticketId,
  uploadId: crypto.randomUUID(), assetId: crypto.randomUUID(), dispatchKey: hash("dispatch"), executionDigest: hash("execute"), fenceToken: crypto.randomUUID(), objectKey: hash("object"), objectVersion: ticketId,
  sizeBytes: bytes.length, sha256: hash(bytes), mediaKind: kind, startedAt: now, deadlineAt: now + 180000, maxRuntimeMs: 180000 }; }
test("actual PNG inspection crosses native process boundary and recovery does not read source again", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, false), bytes = await require("sharp")({ create: { width: 96, height: 160, channels: 3, background: "#375a7f" } }).png().toBuffer(), task = inspectionTask(bytes); let reads = 0;
  const options = { provider: { async streamSealedObject({ consume }) { reads++; await consume(bytes); return { sizeBytes: bytes.length, sha256: hash(bytes) }; } }, workingDirectory: f.staging, executor: f.executor, assertExecutionHeld: async () => true };
  const worker = createProcessDiskInspectionWorker(options), executionId = crypto.randomUUID(), result = await worker.inspect(task, { executionId });
  assert.equal(result.state, "succeeded"); assert.equal(result.result.inspection.decoded, true); assert.equal(result.result.inspection.width, 96); assert.equal(result.result.inspection.sha256, task.sha256);
  assert.equal(result.termination.proved, true); assert.equal(reads, 1);
  assert.deepEqual(await createProcessDiskInspectionWorker({ ...options, executor: createMediaProcessExecutor(f.options) }).observe(task, { executionId }), result);
  const reordered = Object.fromEntries(Object.keys(task).reverse().map(key => [key, task[key]]));
  assert.deepEqual(await createProcessDiskInspectionWorker(options).observe(reordered, { executionId }), result);
  assert.equal((await createProcessDiskInspectionWorker(options).observe({ ...task, userId: crypto.randomUUID() }, { executionId })).state, "unknown");
  assert.equal(reads, 1); assert.equal((await fs.readdir(path.join(f.staging, executionId))).includes(task.companyId), false);
  t.diagnostic(JSON.stringify({ case: "png-inspection", metrics: result.metrics, elapsedMs: result.elapsedMs }));
});
test("wrong source hash and revoked owner fail before launch, preserving only owned receipts", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), bytes = Buffer.from("synthetic-bad-image"), task = inspectionTask(bytes);
  const worker = createProcessDiskInspectionWorker({ provider: { async streamSealedObject({ consume }) { await consume(Buffer.from("different")); return {}; } }, workingDirectory: f.staging, executor: f.executor, assertExecutionHeld: async () => true });
  const result = await worker.inspect(task, { executionId: crypto.randomUUID() }); assert.equal(result.state, "failed"); assert.equal(result.termination.proved, true);
  const denied = createProcessDiskInspectionWorker({ provider: { streamSealedObject() { assert.fail("must not read"); } }, workingDirectory: f.staging, executor: f.executor, assertExecutionHeld: async () => false });
  assert.equal((await denied.inspect(task, { executionId: crypto.randomUUID() })).state, "failed");
  assert.equal((await fs.readdir(f.executionRoot)).length, 0);
});
test("a deferred staging await keeps ownership until settlement and is not converted into fake hard timeout", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), bytes = Buffer.from("synthetic-staging-only"), task = inspectionTask(bytes); let now = task.startedAt, release, reached;
  const waiting = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; }); let settled = false;
  const worker = createProcessDiskInspectionWorker({ provider: { async streamSealedObject({ consume }) { reached(); await waiting; await consume(bytes); return { sizeBytes: bytes.length, sha256: hash(bytes) }; } },
    workingDirectory: f.staging, executor: f.executor, assertExecutionHeld: async () => true, clock: () => now });
  const result = worker.inspect(task, { executionId: crypto.randomUUID() }).then(value => { settled = true; return value; });
  await entered; now += 180001; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(); const terminal = await result; assert.equal(terminal.state, "failed"); assert.equal(terminal.reason, "process_disk_deadline_exceeded"); assert.equal(terminal.termination.proved, true);
  assert.equal((await fs.readdir(f.executionRoot)).length, 0);
});
test("unknown files beside own snapshot prevent cleanup proof and are never deleted", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), bytes = Buffer.from("synthetic-unknown-file"), task = inspectionTask(bytes), executionId = crypto.randomUUID(); let allowed = true;
  const worker = createProcessDiskInspectionWorker({ provider: { async streamSealedObject({ consume }) {
    await consume(bytes); await fs.writeFile(path.join(f.staging, executionId, task.companyId, "foreign.bin"), "synthetic foreign sentinel", { flag: "wx" }); allowed = false;
    return { sizeBytes: bytes.length, sha256: hash(bytes) };
  } }, workingDirectory: f.staging, executor: f.executor, assertExecutionHeld: async () => allowed });
  const result = await worker.inspect(task, { executionId }); assert.equal(result.state, "unknown"); assert.equal(result.reason, "cleanup_unproven"); assert.equal(result.termination, undefined);
  assert.equal(await fs.readFile(path.join(f.staging, executionId, task.companyId, "foreign.bin"), "utf8"), "synthetic foreign sentinel");
  assert.equal(hash(await fs.readFile(path.join(f.staging, executionId, task.companyId, "snapshot.bin"))), task.sha256);
  assert.equal((await fs.readdir(f.executionRoot)).length, 0);
});
async function prepareRequest(f, bytes, selection, extra = {}) {
  const companyId = crypto.randomUUID(), assetId = crypto.randomUUID(), sourceName = `${crypto.randomUUID()}.${selection.kind === "video" ? "mp4" : "png"}`;
  await fs.mkdir(path.join(f.staging, companyId), { mode: 0o700 }); await fs.writeFile(path.join(f.staging, companyId, sourceName), bytes, { flag: "wx", mode: 0o600 });
  const executionId = crypto.randomUUID(), now = Date.now();
  const result = await f.executor.run({ executionId, operation: "prepare", timeoutMs: 30000, input: { companyId, assetId, sourceName, selection,
    inputRoot: f.staging, outputRoot: f.output, logicalNow: now, deadlineAt: now + 180000, ...extra } });
  assert.equal(result.state, "succeeded", JSON.stringify(result)); assert.equal(result.termination.proved, true); assert.equal(result.result.sourceSha256, hash(bytes));
  assert.equal(hash(await fs.readFile(path.join(f.staging, companyId, sourceName))), hash(bytes));
  return { ...result, companyId, assetId };
}
test("real PNG prepares JPEG in child and final derivative is fully decoded in another supervised tree", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, false), bytes = await require("sharp")({ create: { width: 96, height: 160, channels: 3, background: "#4a728c" } }).png().toBuffer();
  const prepared = await prepareRequest(f, bytes, { kind: "image", targets: ["feed"], audioMode: "none", musicalTargets: [] });
  const descriptor = prepared.result.variants.feed, filePath = path.join(f.output, prepared.companyId, prepared.assetId, descriptor.fileName);
  assert.equal(hash(await fs.readFile(filePath)), descriptor.sha256);
  const inspector = require("../src/social/calendar/imports/prepared-disk-output-inspector").createPreparedDiskOutputInspector({ processExecutor: f.executor });
  const inspected = await f.executor.withExecutionScope(prepared.executionId, () => inspector.inspectFile({ filePath, descriptor, timeoutMs: 30000 }));
  assert.equal(inspected.decoded, true); assert.equal(inspected.width, 1080); assert.equal(inspected.height, 1350);
  assert.equal((await f.executor.terminationProof(prepared.executionId)).proved, true);
  t.diagnostic(JSON.stringify({ case: "photo-prepare", metrics: prepared.metrics, elapsedMs: prepared.elapsedMs, outputBytes: descriptor.size }));
});
test("real 3-second MP4 original and muted are prepared with bounded actual codecs", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, false), source = path.join(f.root, "synthetic-three-seconds.mp4");
  const generated = await require("../src/social/calendar/imports/preparation").runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=96x160:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", source], { cwd: f.root, timeoutMs: 10000 });
  assert.equal(generated.code, 0); const bytes = await fs.readFile(source);
  for (const audioMode of ["original", "muted"]) {
    const prepared = await prepareRequest(f, bytes, { kind: "video", targets: ["story", "reel"], audioMode, musicalTargets: [] });
    assert.deepEqual(prepared.result.variants.story, prepared.result.variants.reel); const part = prepared.result.variants.story;
    assert.equal(part.videoCodec, "h264"); assert.equal(part.hasAudio, audioMode === "original"); assert.equal(part.audioCodec, audioMode === "original" ? "aac" : null);
    assert.ok(part.durationSeconds >= 3 && part.durationSeconds <= 3.25, JSON.stringify({ audioMode, duration: part.durationSeconds, decodedEnd: part.decodedEndSeconds }));
    const longRoot = path.join(f.output, "a".repeat(60), "b".repeat(60), "c".repeat(60)); await fs.mkdir(longRoot, { recursive: true });
    const longFile = path.join(longRoot, part.fileName); assert.ok(longFile.length > 300);
    await fs.copyFile(path.join(f.output, prepared.companyId, prepared.assetId, part.fileName), longFile);
    const inspected = await f.executor.withExecutionScope(prepared.executionId, () => f.executor.inspectPreparedFile({ filePath: longFile, descriptor: part, timeoutMs: 30000 }));
    assert.equal(inspected.hasAudio, audioMode === "original"); assert.equal(inspected.decoded, true);
    t.diagnostic(JSON.stringify({ case: `three-second-${audioMode}`, metrics: prepared.metrics, elapsedMs: prepared.elapsedMs, outputBytes: part.size }));
  }
});
test("real synthetic photo music keeps non-commercial flag and reuses Story/Reel derivative", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, false), source = path.join(f.staging, "synthetic-tone.wav");
  const generated = await require("../src/social/calendar/imports/preparation").runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000", "-t", "15", "-c:a", "pcm_s16le", source], { cwd: f.root, timeoutMs: 10000 });
  assert.equal(generated.code, 0);
  const bytes = await require("sharp")({ create: { width: 96, height: 160, channels: 3, background: "#856243" } }).png().toBuffer();
  const prepared = await prepareRequest(f, bytes, { kind: "image", targets: ["feed", "story", "reel"], audioMode: "music", musicalTargets: ["story", "reel"], musicTrackId: "synthetic-tone" },
    { music: { root: f.staging, name: "synthetic-tone.wav", sha256: hash(await fs.readFile(source)), synthetic: true } });
  assert.equal(prepared.result.commercialReady, false); assert.deepEqual(prepared.result.variants.story, prepared.result.variants.reel);
  assert.equal(prepared.result.variants.feed.hasAudio, false); assert.equal(prepared.result.variants.story.hasAudio, true); assert.equal(prepared.result.variants.story.durationSeconds, 15);
  t.diagnostic(JSON.stringify({ case: "photo-15-second-synthetic-music", metrics: prepared.metrics, elapsedMs: prepared.elapsedMs, outputBytes: prepared.result.variants.story.size }));
});
