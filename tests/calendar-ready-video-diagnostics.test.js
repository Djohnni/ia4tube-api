"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { CODE, COMPLETED_CODE, createReadyVideoDiagnostics, observeReadyVideoOperation, wrapReadyVideoUploadDiagnostics } = require("../src/social/calendar/imports/ready-video-diagnostics");
const { sanitizeSocialDiagnostic, createSocialDiagnosticLogger } = require("../src/social/server-runtime");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const { createRenderDiskPrivateUploadProvider } = require("../src/social/calendar/imports/render-disk-provider");
const { createRenderDiskAdmission } = require("../src/social/calendar/imports/render-disk-admission");
const { createRenderDiskTransferService } = require("../src/social/calendar/imports/transfer-service");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const owner = Object.freeze({ authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() });
const SECRET = "SENTINEL_SECRET_https://private.invalid/?grant=private-token";
const failure = code => Object.assign(new Error(SECRET), { code, stack: SECRET, authorizationId: SECRET, url: SECRET, headers: { authorization: SECRET } });
function fixture(logger, options = {}) { return createReadyVideoDiagnostics({ logger, owner, ...options }); }

test("error-only projection preserves exact stages/reasons and never includes errors, requests, IDs or accessors", async () => {
  const events = [], diagnostics = fixture(createSocialDiagnosticLogger({ error: value => events.push(value) }));
  let getters = 0;
  for (const code of ["disk_part_conflict", "media_capacity_disk_space_evidence_invalid", "import_transfer_timeout", "media_transfer_registry_full",
    "ENOENT", "EACCES", "ENOSPC", "EIO", "EMFILE", "ENFILE", "EPERM", "ELOOP"]) {
    const error = failure(code);
    Object.defineProperty(error, "privateAccessor", { get() { getters++; throw new Error(SECRET); } });
    await assert.rejects(observeReadyVideoOperation(diagnostics, "provider_accept_part", { ...owner, secret: SECRET }, () => { throw error; }), value => value === error);
    assert.equal(events.at(-1).reasonCode, code);
  }
  const disguised = failure("disk_private_secret_" + owner.userId.replace(/-/g, ""));
  await assert.rejects(observeReadyVideoOperation(diagnostics, "provider_accept_part", owner, () => Promise.reject(disguised)), value => value === disguised);
  assert.equal(events.at(-1).reasonCode, "unclassified");
  const accessor = new Error(SECRET); Object.defineProperty(accessor, "code", { get() { getters++; return "disk_part_conflict"; } });
  await assert.rejects(observeReadyVideoOperation(diagnostics, "provider_accept_part", owner, () => { throw accessor; }), value => value === accessor);
  assert.equal(events.at(-1).reasonCode, "unclassified"); assert.equal(getters, 0);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["component", "code", "stage", "reasonCode", "elapsedMs"].sort());
    assert.equal(event.component, "calendar_ready_video"); assert.equal(event.code, CODE);
    assert.ok(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs <= 300000);
    assert.equal(Object.isFrozen(event), true);
  }
  assert.doesNotMatch(JSON.stringify(events), /SENTINEL|https|private-token/);
  assert.equal(JSON.stringify(events).includes(owner.companyId), false); assert.equal(JSON.stringify(events).includes(owner.userId), false);
});

test("default, cloned observer, another owner, inactive owner and successful operations remain quiet", async () => {
  const events = [], diagnostics = fixture({ error: value => events.push(value) });
  const original = failure("disk_part_conflict");
  for (const [observer, context] of [[undefined, owner], [{ ...diagnostics }, owner], [diagnostics, { ...owner, userId: crypto.randomUUID() }],
    [fixture({ error: value => events.push(value) }, { isEligibleOwner: () => false }), owner]]) {
    await assert.rejects(observeReadyVideoOperation(observer, "provider_accept_part", context, () => { throw original; }), value => value === original);
  }
  await assert.rejects(observeReadyVideoOperation(diagnostics, SECRET, owner, () => { throw original; }), value => value === original);
  assert.equal(await observeReadyVideoOperation(diagnostics, "provider_accept_part", owner, () => 42), 42);
  assert.deepEqual(events, []);
});

test("throwing and asynchronously rejecting loggers cannot replace the original operation error or trigger retries", async () => {
  for (const error of [() => { throw new Error(SECRET); }, () => Promise.reject(new Error(SECRET))]) {
    let operations = 0; const original = failure("disk_part_conflict"), diagnostics = fixture({ error });
    await assert.rejects(observeReadyVideoOperation(diagnostics, "provider_accept_part", owner, () => { operations++; throw original; }), value => value === original);
    assert.equal(operations, 1);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("final sanitizer accepts only the exact ready-video taxonomy and rejects unsafe/accessor values", () => {
  const base = { component: "calendar_ready_video", code: CODE, stage: "upload_resume", reasonCode: "disk_part_conflict", elapsedMs: 123 };
  assert.deepEqual(sanitizeSocialDiagnostic({ ...base, message: SECRET, token: SECRET, companyId: owner.companyId }), base);
  for (const patch of [{ component: "social_postgres" }, { stage: SECRET }, { reasonCode: "disk_" + SECRET }, { reasonCode: undefined },
    { elapsedMs: -1 }, { elapsedMs: 300001 }, { elapsedMs: 1.5 }, { stage: undefined }]) assert.equal(sanitizeSocialDiagnostic({ ...base, ...patch }), null);
  let invoked = false; const accessor = { ...base };
  Object.defineProperty(accessor, "reasonCode", { get() { invoked = true; return "disk_part_conflict"; } });
  assert.equal(sanitizeSocialDiagnostic(accessor), null); assert.equal(invoked, false);
});

test("final upload facade diagnoses start/resume/authorize/resolve/complete without changing return/error contracts", async () => {
  const events = [], diagnostics = fixture({ error: value => events.push(value) });
  const original = failure("import_operation_unavailable"), methods = ["start", "resume", "authorizePart", "resolvePart", "complete"];
  const upload = Object.fromEntries(methods.map(method => [method, async () => { throw original; }]));
  assert.equal(wrapReadyVideoUploadDiagnostics(upload), upload);
  const wrapped = wrapReadyVideoUploadDiagnostics(upload, diagnostics);
  for (const method of methods) await assert.rejects(wrapped[method](owner, { secret: SECRET }), value => value === original);
  assert.deepEqual(events.map(value => value.stage), ["upload_start", "upload_resume", "upload_authorize_part", "upload_resolve_part", "upload_complete"]);
});

test("only five metadata successes emit completed and final taxonomy forbids mixed failure/success pairs", async () => {
  const events = [], diagnostics = fixture(createSocialDiagnosticLogger({ error: event => events.push(event) }));
  const methods = ["start", "resume", "authorizePart", "resolvePart", "complete"];
  const returned = Object.freeze({ secret: SECRET });
  const wrapped = wrapReadyVideoUploadDiagnostics(Object.fromEntries(methods.map(method => [method, async () => returned])), diagnostics);
  for (const method of methods) assert.equal(await wrapped[method](owner, { secret: SECRET }), returned);
  assert.deepEqual(events.map(event => event.stage), ["upload_start", "upload_resume", "upload_authorize_part", "upload_resolve_part", "upload_complete"]);
  for (const event of events) {
    assert.equal(event.code, COMPLETED_CODE); assert.equal(event.reasonCode, "completed");
    assert.equal(sanitizeSocialDiagnostic({ ...event, code: CODE }), null);
    assert.equal(sanitizeSocialDiagnostic({ ...event, reasonCode: "disk_part_conflict" }), null);
    assert.equal(sanitizeSocialDiagnostic({ ...event, stage: "provider_accept_part" }), null);
    assert.equal(sanitizeSocialDiagnostic({ ...event, stage: "upload_status" }), null);
  }
  for (const stage of ["provider_list_parts", "admission_assert_held", "transfer_resolve_part", "upload_status"]) {
    assert.equal(await observeReadyVideoOperation(diagnostics, stage, owner, () => returned), returned);
  }
  const other = { ...owner, userId: crypto.randomUUID() };
  assert.equal(await wrapped.start(other, {}), returned); assert.equal(events.length, 5);
  for (const error of [() => { throw new Error(SECRET); }, () => Promise.reject(new Error(SECRET))]) {
    const broken = fixture({ error });
    assert.equal(await observeReadyVideoOperation(broken, "upload_resume", owner, () => returned), returned);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(JSON.stringify(events), /SENTINEL|private-token/);
});

test("admission and provider capture internal causes before safe boundaries mask them; public error stays unchanged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ia4tube-safe-diagnostic-")); await fs.chmod(root, 0o700);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("ia4tube-safe-diagnostic-"));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(root, { recursive: true, force: true });
  });
  const events = [], diagnostics = fixture(createSocialDiagnosticLogger({ error: event => events.push(event) }));
  const store = createMemoryImportUploadStore(), original = failure("media_capacity_disk_space_evidence_invalid");
  const capacity = { capabilities: { available: true, atomicGlobalReservations: true, testOnly: true },
    reserveStorage: async () => { throw original; }, sealStorage() {}, assertHeld() {}, cancel() {}, settleStorage() {}, inspect() {} };
  const admission = createRenderDiskAdmission({ capacity, store, rootDirectory: root, enabled: true, allowVolatileForTests: true,
    coordinatorContext: { authenticated: true, role: "calendar_media_capacity_coordinator" }, diagnostics });
  const inspector = { capabilities: { isolated: true, bounded: true, remoteObjectInspection: true }, startInspection() {}, getInspection() {} };
  const provider = createRenderDiskPrivateUploadProvider({ rootDirectory: root, store, admission, inspector,
    transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, allowVolatileForTests: true, diagnostics });
  const upload = wrapReadyVideoUploadDiagnostics(createCalendarImportUploadService({ store, provider, enabled: true, allowVolatileForTests: true }), diagnostics);
  await assert.rejects(upload.start(owner, { idempotencyKey: crypto.randomUUID(), kind: "video", mimeType: "video/mp4", sizeBytes: 10, sha256: "a".repeat(64) }),
    error => error.code === "import_provider_unavailable" && error.statusCode === 503 && !error.message.includes(SECRET));
  assert.deepEqual(events.map(event => [event.stage, event.reasonCode]), [
    ["admission_reserve", "media_capacity_disk_space_evidence_invalid"], ["provider_begin_multipart", "disk_global_capacity_refused"],
    ["upload_start", "import_provider_unavailable"]]);
  assert.doesNotMatch(JSON.stringify(events), /SENTINEL|private-token/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("transfer resolution captures registry-class errors before masking and the final upload facade reports resolve", async () => {
  const events = [], diagnostics = fixture(createSocialDiagnosticLogger({ error: event => events.push(event) }));
  const store = createMemoryImportUploadStore();
  const accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [{ ...owner, audience: "customers" }] });
  const registry = { capabilities: { persistence: "volatile-test", available: true, testOnly: true }, register() {}, resolve() {}, revoke() {} };
  const provider = { getCapabilities: () => ({ available: true }), acceptPart() {} };
  const transfer = createRenderDiskTransferService({ store, provider, registry, accessPolicy, enabled: true, allowVolatileForTests: true, diagnostics });
  const upload = transfer.wrapUpload({ resolvePart: async () => { throw failure("media_transfer_registry_full"); } });
  await assert.rejects(upload.resolvePart(owner, { authorizationId: crypto.randomUUID() }), { code: "import_transfer_unavailable" });
  assert.deepEqual(events.map(event => [event.stage, event.reasonCode]), [["transfer_resolve_part", "media_transfer_registry_full"], ["upload_resolve_part", "import_transfer_unavailable"]]);
});

test("transfer PUT errors after registry owner resolution and before the provider are diagnosed without exposing binding", async () => {
  const events = [], diagnostics = fixture(createSocialDiagnosticLogger({ error: event => events.push(event) }));
  const store = createMemoryImportUploadStore();
  const accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [{ ...owner, audience: "customers" }] });
  const registry = { capabilities: { persistence: "volatile-test", available: true, testOnly: true }, register() {}, revoke() {},
    async resolve() { return { companyId: owner.companyId, userId: owner.userId, assetId: crypto.randomUUID(), secret: SECRET }; } };
  let providerCalled = false;
  const provider = { getCapabilities: () => ({ available: true }), acceptPart() { providerCalled = true; } };
  const transfer = createRenderDiskTransferService({ store, provider, registry, accessPolicy, enabled: true, allowVolatileForTests: true, diagnostics });
  await assert.rejects(transfer.acceptPart({ authorizationId: crypto.randomUUID(), stream: {} }), { code: "import_transfer_not_found" });
  assert.equal(providerCalled, false);
  assert.deepEqual(events.map(event => [event.stage, event.reasonCode]), [["transfer_accept_part", "import_transfer_not_found"]]);
  assert.doesNotMatch(JSON.stringify(events), /SENTINEL|private-token/);
});
