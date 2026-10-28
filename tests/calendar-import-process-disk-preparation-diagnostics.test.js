"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), fsSync = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), Module = require("node:module");
const WORKER = require.resolve("../src/social/calendar/imports/process-disk-preparation-worker");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(t, { sourceError, admissionError, nativeError } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ia4tube-preparation-diagnostic-"));
  const workingDirectory = path.join(root, "attempts"), preparationRoot = path.join(root, "prepared");
  for (const directory of [root, workingDirectory, preparationRoot]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700);
  }
  t.after(async () => {
    const exact = path.resolve(root);
    assert.equal(path.dirname(exact), path.resolve(os.tmpdir()));
    assert.ok(path.basename(exact).startsWith("ia4tube-preparation-diagnostic-"));
    await fs.rm(exact, { recursive: true, force: true });
  });
  const bytes = Buffer.from("private source test bytes"), calls = { source: 0, admission: 0, native: 0 };
  const admission = { async assertHeld() { calls.admission++; if (admissionError) throw admissionError; return true; } };
  const resultStore = {};
  const executor = { capabilities: { supported: true, hardTermination: true },
    async run() { calls.native++; throw nativeError || new Error("Unexpected native launch"); },
    async terminationProof() { return { proved: true, descendants: 0, proofId: "a".repeat(64) }; }
  };
  const load = Module.createRequire(WORKER), loaded = new Module(WORKER, module);
  loaded.filename = WORKER; loaded.paths = Module._nodeModulePaths(path.dirname(WORKER));
  loaded.require = name => {
    const actual = load(name);
    if (name === "./media-process-executor") return { ...actual, isMediaProcessExecutor: value => value === executor };
    if (name === "./prepared-disk-admission") return { ...actual, isPreparedDiskAdmission: value => value === admission };
    if (name === "./prepared-disk-store") return { ...actual, isPreparedDiskResultStore: value => value === resultStore };
    return actual;
  };
  loaded._compile(fsSync.readFileSync(WORKER, "utf8"), WORKER);
  const task = { schema: 1, jobId: crypto.randomUUID(), companyId: crypto.randomUUID(), userId: crypto.randomUUID(),
    assetId: crypto.randomUUID(), uploadId: crypto.randomUUID(), leaseToken: crypto.randomUUID(), dispatchKey: "b".repeat(64),
    executionDigest: "c".repeat(64), mediaRevision: 1, fence: 1, deadlineAt: Date.now() + 180000, maxRuntimeMs: 180000,
    reservedOutputBytes: 1024, source: { objectKey: "d".repeat(64), objectVersion: crypto.randomUUID(), sha256: hash(bytes), sizeBytes: bytes.length },
    selection: { kind: "video", targets: ["reel"], audioMode: "original" }, plan: {} };
  const provider = { async streamSealedObject({ consume }) {
    calls.source++; if (sourceError) throw sourceError; await consume(bytes); return { sizeBytes: bytes.length, sha256: hash(bytes) };
  } };
  const worker = loaded.exports.createProcessDiskPreparationWorker({ provider, workingDirectory, preparationRoot, resultStore, admission, executor });
  const binding = { executionId: crypto.randomUUID(), resultRef: crypto.randomUUID() };
  return { worker, task, binding, calls, preparationRoot, workingDirectory,
    terminal: () => fs.readFile(path.join(workingDirectory, binding.executionId, "worker-terminal.json"), "utf8").then(JSON.parse) };
}

test("failed GCS snapshot keeps a private bounded diagnostic without relaunching the same execution", async t => {
  const f = await fixture(t, { sourceError: Object.assign(new Error("https://secret.example/?token=private"), { code: "import_gcs_unavailable" }) });
  const result = await f.worker.execute(f.task, f.binding);
  assert.equal(result.state, "failed"); assert.equal(result.reason, "preparation_failed");
  assert.deepEqual(result.diagnostic, { stage: "source_snapshot", code: "import_gcs_unavailable", nativeLaunchAttempted: false });
  assert.equal(result.termination.proved, true); assert.deepEqual(f.calls, { source: 1, admission: 1, native: 0 });
  assert.deepEqual(await f.terminal(), result);
  assert.deepEqual(await f.worker.execute(f.task, f.binding), result);
  assert.deepEqual(f.calls, { source: 1, admission: 1, native: 0 });
  assert.equal(JSON.stringify(result).includes("secret.example"), false);
  assert.equal(JSON.stringify(result).includes("token=private"), false);
});

test("admission failure is distinguishable from a failed source download and never starts native work", async t => {
  const f = await fixture(t, { admissionError: Object.assign(new Error("private owner details"), { code: "prepared_admission_owner_invalid" }) });
  const result = await f.worker.execute(f.task, f.binding);
  assert.equal(result.state, "failed"); assert.equal(result.reason, "preparation_failed");
  assert.deepEqual(result.diagnostic, { stage: "admission_check", code: "prepared_admission_owner_invalid", nativeLaunchAttempted: false });
  assert.deepEqual(f.calls, { source: 0, admission: 1, native: 0 });
});

test("disk-space failure retains ENOSPC without copying its private path or message", async t => {
  const f = await fixture(t, { sourceError: Object.assign(new Error("disk full at /private/user/uploads/secret.mp4"), { code: "ENOSPC", path: "/private/user/uploads/secret.mp4" }) });
  const result = await f.worker.execute(f.task, f.binding);
  assert.deepEqual(result.diagnostic, { stage: "source_snapshot", code: "ENOSPC", nativeLaunchAttempted: false });
  assert.equal(JSON.stringify(result).includes("secret.mp4"), false);
  assert.equal(JSON.stringify(result).includes("disk full"), false);
});

test("arbitrary and transport-looking exception codes are not persisted as diagnostics", async t => {
  const f = await fixture(t, { sourceError: Object.assign(new Error("sensitive message"), { code: "gcs_transport_sensitive_secret" }) });
  const result = await f.worker.execute(f.task, f.binding);
  assert.equal(result.reason, "preparation_failed"); assert.equal(result.diagnostic.code, "unclassified");
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
});

test("output-directory failure is recorded before admission, download or native launch", async t => {
  const f = await fixture(t); await fs.rmdir(f.preparationRoot);
  const result = await f.worker.execute(f.task, f.binding);
  assert.deepEqual(result.diagnostic, { stage: "output_directory", code: "ENOENT", nativeLaunchAttempted: false });
  assert.deepEqual(f.calls, { source: 0, admission: 0, native: 0 });
});

test("a launch failure keeps the native boundary and the existing public reason", async t => {
  const f = await fixture(t, { nativeError: Object.assign(new Error("internal unavailable"), { code: "gcs_transport_timeout" }) });
  const result = await f.worker.execute(f.task, f.binding);
  assert.equal(result.state, "failed"); assert.equal(result.reason, "preparation_failed");
  assert.deepEqual(result.diagnostic, { stage: "native_preparation", code: "gcs_transport_timeout", nativeLaunchAttempted: true });
  assert.deepEqual(f.calls, { source: 1, admission: 3, native: 1 });
});
