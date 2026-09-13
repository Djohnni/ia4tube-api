"use strict";
// One sequential suite is the paid-probe candidate: eight explicitly counted
// supervised attempts, not a retry loop. A failed case prevents later launches.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { createMediaProcessExecutor } = require("../src/social/calendar/imports/media-process-executor");
const { INSTALLED } = require("../src/social/calendar/imports/linux-media-runtime");
const linuxRuntime = { cgroupRoot: INSTALLED.cgroupRoot, launchMode: "installed", validationOnly: true };
const options = { workingRoot: INSTALLED.executionRoot, ffmpegPath: INSTALLED.ffmpeg, allowedRoots: [INSTALLED.workRoot + "/data"], syntheticTests: true, linuxRuntime };
let executor, failed = false, attempts = 0; const launched = [], prefix = crypto.randomUUID();
const caseIds = { "installed preflight identity and immutable launcher": "installed-preflight", "installed codec cannot read coordinator or another tenant": "identity-read-isolation",
  "installed aggregate scratch quota fails closed": "aggregate-space", "installed aggregate deadline terminates descendants": "deadline-descendants", "installed preparation and independent validation": "source-limit" };
function checked(name, action, timeout = 30000) { test(name, { timeout }, async t => {
  assert.equal(failed, false, "Prior proof failure: no later launch is permitted");
  const before = attempts;
  try { await action(t); t.diagnostic("VM_INSTALLED_CASE=" + JSON.stringify({ id: caseIds[name], passed: true, terminationProved: true, nativeLaunches: attempts - before }));
    if (caseIds[name] === "source-limit") t.diagnostic("VM_INSTALLED_TOTAL=" + JSON.stringify({ launches: attempts, allTerminated: true, attemptIds: launched.map(row => row.name) }));
  } catch (error) { failed = true;
    t.diagnostic("VM_INSTALLED_CASE=" + JSON.stringify({ id: caseIds[name], passed: false, terminationProved: false, nativeLaunches: attempts - before }));
    t.diagnostic("VM_INSTALLED_TOTAL=" + JSON.stringify({ launches: attempts, allTerminated: false, attemptIds: launched.map(row => row.name) })); throw error;
  }
}); }
async function run(name, operation, input, timeoutMs = 180000) {
  assert.ok(++attempts <= 8, "Reviewed proof has exactly eight maximum attempts");
  const executionId = crypto.randomUUID(); launched.push({ name, executionId });
  const result = await executor.run({ executionId, operation, input, timeoutMs });
  return { ...result, request: { executionId, operation, input, timeoutMs } };
}
function success(result) { assert.equal(result.state, "succeeded", JSON.stringify(result)); assert.equal(result.termination?.proved, true); assert.equal(result.termination.descendants, 0); }
checked("installed preflight identity and immutable launcher", async t => {
  assert.equal(process.platform, "linux"); assert.ok(process.getuid() > 0);
  const record = JSON.parse(await fs.readFile("/opt/ia4tube-media/installation.json", "utf8"));
  assert.equal(process.getuid(), record.coordinatorUid); assert.notEqual(record.codecUid, record.coordinatorUid);
  const native = await fs.stat(INSTALLED.native); assert.equal(native.uid, 0); assert.equal(native.mode & 0o222, 0);
  executor = createMediaProcessExecutor(options); assert.equal(executor.capabilities.hardTermination, false);
  attempts++; launched.push({ name: "native-preflight", executionId: "probe" });
  const prepared = await executor.prepareRuntime();
  for (const key of ["readIsolatedRoot", "distinctCodecUid", "installedLauncher", "cgroupV2", "pidfd"]) assert.equal(prepared.capabilities[key], true, key);
  assert.equal(prepared.capabilities.aggregateScratchQuotaBytes, 3221225472);
  t.diagnostic(JSON.stringify({ case: "installed-preflight", nativeAttempts: 1, hostProductionApproved: false, capabilities: prepared.capabilities }));
});
checked("installed codec cannot read coordinator or another tenant", async t => {
  const peer = INSTALLED.workRoot + "/data/synthetic-other-company"; await fs.mkdir(peer, { mode: 0o700 });
  await fs.writeFile(peer + "/art.txt", "synthetic-peer-only", { flag: "wx", mode: 0o600 });
  await fs.writeFile("/var/lib/ia4tube-media/state/synthetic-journal.json", "synthetic-journal-only", { flag: "wx", mode: 0o600 });
  const result = await run("read-isolation", "test_tree", { mode: "linux_read_isolation" }); success(result);
  const record = JSON.parse(await fs.readFile("/opt/ia4tube-media/installation.json", "utf8"));
  assert.equal(result.result.uid, record.codecUid); assert.notEqual(result.result.uid, process.getuid()); assert.equal(result.result.pid, 1);
  for (const [key, value] of Object.entries(result.result)) if (!['uid','gid','pid','environmentKeys','interfaces'].includes(key)) assert.equal(value, true, key);
  assert.deepEqual(result.result.interfaces, ["lo"]); assert.deepEqual(result.result.environmentKeys, ["LANG", "LC_ALL", "TMPDIR", "UV_THREADPOOL_SIZE"]);
  const replay = await executor.run(result.request); assert.equal(replay.termination.proofId, result.termination.proofId);
  assert.equal(await fs.readFile(peer + "/art.txt", "utf8"), "synthetic-peer-only");
  await fs.unlink(peer + "/art.txt"); await fs.rmdir(peer); await fs.unlink("/var/lib/ia4tube-media/state/synthetic-journal.json");
  t.diagnostic(JSON.stringify({ case: "installed-read-isolation", nativeAttempts: 1, replayLaunched: false, checks: result.result }));
});
checked("installed aggregate scratch quota fails closed", async t => {
  const result = await run("aggregate-quota", "test_tree", { mode: "linux_aggregate_quota" }); success(result);
  assert.equal(result.result.quotaRefused, true); assert.ok(result.result.filesAttempted > 16);
  assert.ok(result.result.bytesWritten > 2 * 1024 ** 3); assert.ok(result.result.bytesWritten <= INSTALLED.quotaBytes);
  assert.ok(result.result.aggregateVolumeBytes <= INSTALLED.quotaBytes);
  assert.ok(result.result.freeBytesAfterOwnCleanup > 2 * 1024 ** 3);
  assert.equal(result.limits.memoryBytes, 536870912); assert.equal(result.limits.maxTasks, 64); assert.equal(result.limits.swapBytes, 0);
  t.diagnostic(JSON.stringify({ case: "installed-quota", nativeAttempts: 1, result: result.result, metrics: result.metrics }));
}, 190000);
checked("installed aggregate deadline terminates descendants", async t => {
  const result = await run("aggregate-deadline", "test_tree", { mode: "stall" }, 2000);
  assert.equal(result.state, "failed"); assert.equal(result.reason, "timed_out"); assert.equal(result.termination?.proved, true);
  const marker = path.join(INSTALLED.executionRoot, result.executionId, "descendant.tick"), tick = await fs.readFile(marker, "utf8");
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await fs.readFile(marker, "utf8"), tick);
  t.diagnostic(JSON.stringify({ case: "installed-deadline", nativeAttempts: 1, elapsedMs: result.elapsedMs, termination: result.termination }));
});
checked("installed preparation and independent validation", async t => {
  const generated = await run("generate-source", "test_tree", { mode: "linux_generate_source" }); success(generated);
  assert.equal(generated.result.size, 100 * 1024 ** 2);
  const companyId = crypto.randomUUID(), assetId = crypto.randomUUID(), ticketId = crypto.randomUUID();
  const data = path.join(INSTALLED.workRoot, "data", prefix), inputRoot = data + "/input", outputRoot = data + "/output";
  await fs.mkdir(inputRoot + "/" + companyId, { recursive: true, mode: 0o700 }); await fs.mkdir(outputRoot, { mode: 0o700 });
  const sourceName = crypto.randomUUID() + ".mp4", sourcePath = path.join(inputRoot, companyId, sourceName);
  await fs.copyFile(path.join(INSTALLED.executionRoot, generated.executionId, "synthetic-60s.mp4"), sourcePath, require("node:fs").constants.COPYFILE_EXCL);
  const now = Date.now(), hash = value => crypto.createHash("sha256").update(value).digest("hex");
  const task = { schema: 1, kind: "inspect_import", providerType: "render_disk", companyId, userId: crypto.randomUUID(), ticketId,
    uploadId: crypto.randomUUID(), assetId, dispatchKey: hash("dispatch"), executionDigest: hash("execution"), fenceToken: crypto.randomUUID(),
    objectKey: hash("object"), objectVersion: ticketId, sizeBytes: generated.result.size, sha256: generated.result.sha256, mediaKind: "video", startedAt: now, deadlineAt: now + 180000, maxRuntimeMs: 180000 };
  const inspected = await run("inspect-source", "inspect", { task, sourcePath, logicalNow: now }); success(inspected);
  assert.equal(inspected.result.inspection.decoded, true);
  const logicalNow = Date.now();
  const prepared = await run("prepare-media", "prepare", { companyId, assetId, sourceName, inputRoot, outputRoot, logicalNow, deadlineAt: logicalNow + 180000,
    selection: { kind: "video", targets: ["story", "reel"], audioMode: "original", shareToFeed: true } }); success(prepared);
  const descriptor = prepared.result.variants.story; assert.equal(descriptor.fileName, prepared.result.variants.reel.fileName);
  const filePath = path.join(outputRoot, companyId, assetId, descriptor.fileName);
  const decoded = await run("inspect-derivative", "inspect_output", { filePath, descriptor }, 30000); success(decoded);
  assert.equal(decoded.result.decoded, true); assert.ok(Math.abs(decoded.result.durationSeconds - 60) < 0.15);
  assert.equal(attempts, 8);
  t.diagnostic(JSON.stringify({ case: "installed-pipeline", nativeAttempts: 4, source: generated.result, prepared: { elapsedMs: prepared.elapsedMs, metrics: prepared.metrics },
    decoded: { complete: decoded.result.decoded, seconds: decoded.result.durationSeconds }, totalAttempts: attempts, launched }));
}, 560000);
