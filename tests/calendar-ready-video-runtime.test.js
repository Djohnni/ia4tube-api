"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { loadReadyVideoConfig, resolveReadyVideoOwners, ENABLED, SUBJECTS } = require("../src/social/calendar/imports/ready-video-config");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const { createReadyVideoRuntime, restrictReadyVideoServices, createReadyVideoUploadCompletion, createReadyVideoUploadReconciliation, routeRunners } = require("../src/social/calendar/imports/ready-video-runtime");
const A = { companyId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", audience: "customers" };
const B = { companyId: "33333333-3333-4333-8333-333333333333", userId: "44444444-4444-4444-8444-444444444444", audience: "customers" };
const context = { authenticated: true, ...A };
const enabled = () => ({ ENVIRONMENT: "production", PUBLIC_API_BASE_URL: "https://ia4tube-api.onrender.com",
  SOCIAL_PERSISTENCE_ENABLED: "true", SOCIAL_CALENDAR_ENABLED: "true", SOCIAL_INSTAGRAM_ENABLED: "true",
  META_APP_REVIEW_WINDOW_ENABLED: "false", [ENABLED]: "true", [SUBJECTS]: '["159911205989"]' });
test("server reconciliation waits on absent or partial objects and still requires authoritative complete inspection", async () => {
  const accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [A] });
  let parts = [], state = "uploading", completions = 0;
  const record = () => ({ kind: "video", mimeType: "video/mp4", uploadMode: "single", partCount: 1, sizeBytes: 100, state, completedParts: parts });
  const reconcile = createReadyVideoUploadReconciliation({ accessPolicy, upload: {
    async resume() { return record(); }, async complete() { completions++; state = "verifying"; throw Object.assign(Error(), { code: "import_verification_pending" }); }
  } });
  assert.equal((await reconcile(context, { uploadId: "one" })).state, "uploading");
  parts = [{ partNumber: 1, sizeBytes: 99 }]; await reconcile(context, { uploadId: "one" }); assert.equal(completions, 0);
  parts[0].sizeBytes = 100; assert.equal(await reconcile(context, { uploadId: "one" }), null); assert.equal(completions, 1); assert.equal(state, "verifying");
  state = "uploaded"; assert.equal((await reconcile(context, { uploadId: "one" })).state, "uploaded"); assert.equal(completions, 1);
  await assert.rejects(reconcile({ authenticated: true, ...B }, { uploadId: "one" }), { code: "calendar_import_access_not_allowed" });
});
test("ready video is opt-in and never initializes infrastructure when disabled", async () => {
  assert.equal(loadReadyVideoConfig({}).enabled, false);
  assert.equal(loadReadyVideoConfig({ [ENABLED]: "false" }).enabled, false);
  let read = false;
  assert.equal(await createReadyVideoRuntime({ env: {}, resolveOwnerForSubject() { read = true; } }), null);
  assert.equal(read, false);
  for (const flag of ["", "TRUE", "1", true, null]) assert.throws(() => loadReadyVideoConfig({ [ENABLED]: flag }), { code: "ready_video_configuration_invalid" });
});
test("enablement requires official production and a bounded exact subject list", () => {
  assert.equal(loadReadyVideoConfig(enabled()).enabled, true);
  for (const edit of [{ ENVIRONMENT: "staging" }, { PUBLIC_API_BASE_URL: "https://untrusted.example" },
    { SOCIAL_PERSISTENCE_ENABLED: "false" }, { SOCIAL_CALENDAR_ENABLED: "false" }, { SOCIAL_INSTAGRAM_ENABLED: "false" },
    { META_APP_REVIEW_WINDOW_ENABLED: "true" }, { SOCIAL_MEDIA_IMPORTS_ENABLED: "true" },
    { [SUBJECTS]: "[]" }, { [SUBJECTS]: '["a","a"]' }, { [SUBJECTS]: '[159911205989]' }, { [SUBJECTS]: '["../../secret"]' }]) {
    assert.throws(() => loadReadyVideoConfig({ ...enabled(), ...edit }), error => error.code === "ready_video_configuration_invalid" && !error.message.includes("secret"));
  }
  // Publication/connection gates are still checked by the existing calendar
  // publisher. Closing one does not erase stored uploads or change that gate.
  assert.equal(loadReadyVideoConfig({ ...enabled(), SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false" }).enabled, true);
});
test("subject resolution requires provisioned UUID owners without duplicate mappings", async () => {
  const config = loadReadyVideoConfig(enabled()), seen = [];
  assert.deepEqual(await resolveReadyVideoOwners(config, async subject => { seen.push(subject); return A; }), [A]);
  assert.deepEqual(seen, ["159911205989"]);
  await assert.rejects(resolveReadyVideoOwners(config, async () => ({ companyId: "159911205989", userId: "phone" })), { code: "ready_video_configuration_invalid" });
  await assert.rejects(resolveReadyVideoOwners(loadReadyVideoConfig({ ...enabled(), [SUBJECTS]: '["a","b"]' }), async () => A),
    { code: "ready_video_configuration_invalid" });
});
test("ready-video eligibility is exact per company/user and does not unlock legacy multi-company", () => {
  const access = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [A, B] });
  assert.equal(access.executionAvailable, true);
  assert.deepEqual(access.resolve(context), A);
  assert.throws(() => access.resolve({ ...context, userId: B.userId }), { code: "calendar_import_access_not_allowed" });
  assert.throws(() => access.resolve({ ...context, companyId: B.companyId }), { code: "calendar_import_access_not_allowed" });
  assert.throws(() => access.resolve({ ...context, authenticated: false }), { code: "calendar_import_access_not_allowed" });
  assert.equal(createImportAccessPolicy({ mode: "multi_company", allowedOwners: [A, B] }).executionAvailable, false);
  assert.throws(() => createImportAccessPolicy({ mode: "ready_video", allowedOwners: [{ ...A, audience: "owner_pilot" }] }),
    { code: "calendar_import_access_configuration_invalid" });
});
test("ready-video rejects unsupported transformations before upload or preparation mutation", async () => {
  let uploads = 0, preparations = 0;
  const accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [A] });
  const services = restrictReadyVideoServices({ start() { uploads++; return "upload"; } },
    { request() { preparations++; return "prepare"; } }, accessPolicy);
  assert.equal(services.upload.start(context, { kind: "video", mimeType: "video/mp4" }), "upload");
  for (const input of [{ kind: "image", mimeType: "image/jpeg" }, { kind: "video", mimeType: "video/quicktime" }]) {
    assert.throws(() => services.upload.start(context, input), { code: "calendar_import_ready_video_original_required" });
  }
  const selection = { kind: "video", targets: ["reel"], audioMode: "original", musicalTargets: [], musicTrackId: null };
  assert.equal(services.preparation.request(context, { selection }), "prepare");
  for (const edit of [{ audioMode: "muted" }, { musicTrackId: "track" }, { kind: "image" }])
    assert.throws(() => services.preparation.request(context, { selection: { ...selection, ...edit } }), { code: "calendar_import_ready_video_original_required" });
  assert.throws(() => services.upload.start({ authenticated: true, ...B }, { kind: "video", mimeType: "video/mp4" }), { code: "calendar_import_access_not_allowed" });
  assert.equal(uploads, 1); assert.equal(preparations, 1);
});
test("a caller supplied runner capability object cannot replace a durable runner", () => {
  assert.throws(() => routeRunners([{ owner: A, runner: { capabilities: { hardTermination: true } } }], "inspect"), { code: "ready_video_runner_invalid" });
});
test("one complete call waits for the same inspection and returns uploaded within its bounded window", async () => {
  const calls = [], input = { uploadId: "same-upload" }, accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [A] });
  const complete = createReadyVideoUploadCompletion({ accessPolicy, waitMs: 500, pollMs: 1, upload: { async complete(owner, value) {
    calls.push([owner, value]);
    if (calls.length === 1) throw Object.assign(Error(), { code: "import_verification_pending" });
    return { state: calls.length === 2 ? "verifying" : "uploaded", uploadId: value.uploadId };
  } } });
  assert.deepEqual(await complete(context, input), { state: "uploaded", uploadId: "same-upload" });
  assert.equal(calls.length, 3); assert.ok(calls.every(([owner, value]) => owner === context && value === input));
});
test("a slow in-flight completion returns pending without starting a replacement operation", { timeout: 2000 }, async () => {
  let calls = 0, release;
  const upload = { complete() { calls++; return new Promise(resolve => { release = resolve; }); } };
  const accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [A] });
  const complete = createReadyVideoUploadCompletion({ upload, accessPolicy, waitMs: 20, pollMs: 1 });
  await assert.rejects(complete(context, { uploadId: "same" }), { code: "import_verification_pending", statusCode: 503 });
  assert.equal(calls, 1); release({ state: "uploaded" }); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});
test("invalid media and revoked eligibility do not receive completion retries", async () => {
  let calls = 0;
  const accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [A] });
  const complete = createReadyVideoUploadCompletion({ accessPolicy, waitMs: 100, pollMs: 1,
    upload: { async complete() { calls++; throw Object.assign(Error(), { code: "import_media_verification_failed", statusCode: 422 }); } } });
  await assert.rejects(complete(context, {}), { code: "import_media_verification_failed" }); assert.equal(calls, 1);
  await assert.rejects(complete({ authenticated: true, ...B }, {}), { code: "calendar_import_access_not_allowed" }); assert.equal(calls, 1);
});
test("unsupported muted selection is rejected before accepting or mutating a calendar submission", async () => {
  let writes = 0;
  const accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: [A] });
  const { preparation } = restrictReadyVideoServices({}, {}, accessPolicy);
  const store = { update() { writes++; assert.fail("unsupported selection must not create an accepted intent"); } };
  const submissions = require("../src/social/calendar/imports/calendar-submissions").createCalendarSubmissions({
    store, uploadStore: store, preparation, grants: {}, accessPolicy, resolveConnection() { assert.fail("no connection read needed"); } });
  await assert.rejects(submissions.request(context, { assetId: A.companyId, uploadId: A.userId, idempotencyKey: "native_selection", expectedMediaRevision: 0,
    selection: { kind: "video", targets: ["reel"], audioMode: "muted", musicalTargets: [], musicTrackId: null }, caption: "Oferta comercial" }),
  { code: "calendar_import_ready_video_original_required", statusCode: 400 });
  assert.equal(writes, 0);
});
