"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createCalendarSubmissions } = require("../src/social/calendar/imports/calendar-submissions");
const { createCalendarGrants, isVerifiedCalendarSubmission, isVerifiedCalendarGrant } = require("../src/social/calendar/grants");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createLocalCalendarSimulationStore } = require("../src/social/calendar/imports/local-calendar-simulation");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const { publicationPlan, previewDigest, selection } = require("../src/social/calendar/imports/policy");
const { dateTime, changeJob } = require("../src/social/calendar/model");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
async function fixture() {
  const context = { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() }, assetId = crypto.randomUUID(), uploadId = crypto.randomUUID();
  const simulation = createLocalCalendarSimulationStore({ enabled: true }), store = simulation.store;
  const source = { kind: "image", format: "jpeg", decoded: true, frames: 1, sha256: hash("source"), size: 1024, width: 1080, height: 1350 };
  const chosen = selection({ kind: "image", targets: ["feed"], audioMode: "none" });
  const plan = publicationPlan(chosen, source), part = plan.deliveries[0];
  const variants = { feed: { sha256: hash("feed"), sourceSha256: source.sha256, mimeType: "image/jpeg", width: part.width, height: part.height,
    size: 2048, hasAudio: false, audioMode: "none", durationSeconds: null } };
  const result = { resultRef: crypto.randomUUID(), previewDigest: previewDigest(plan, variants), testOnly: false, variants,
    objects: { feed: { objectKey: hash("object"), objectVersion: crypto.randomUUID(), sha256: variants.feed.sha256, sizeBytes: 2048 } } };
  const upload = { uploadId, assetId, ...context, state: "uploaded", sha256: source.sha256 };
  const uploadStore = { update: async (_company, fn) => fn({ uploads: { [uploadId]: upload } }) };
  let now = dateTime("2026-09-23", "12:00"), prep = null, requested = 0, crashAfterPrepare = false;
  const clock = () => now, key = crypto.randomBytes(32), grants = createCalendarGrants(key, clock);
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [context] });
  const binding = { connectionId: crypto.randomUUID(), externalId: "123456789012345", connectionRevision: 1 };
  await store.update(context.companyId, state => { state.preferences.binding = binding; });
  const preparation = {
    async status() { return prep ? { ...prep, selection: chosen } : { mediaRevision: 0, state: "awaiting_selection", ready: false }; },
    async request(_context, input) {
      if (!prep) { requested++; prep = { assetId, uploadId, mediaRevision: 1, currentRevision: 1, state: "queued", ready: false }; }
      if (crashAfterPrepare) { crashAfterPrepare = false; throw new Error("response_lost"); }
      return { ...prep };
    },
    async snapshot() { return { ...context, assetId, mediaRevision: 1, currentRevision: 1, state: "ready", ready: true, selection: chosen, plan, result }; }
  };
  const options = { store, uploadStore, preparation, grants, accessPolicy, clock, resolveConnection: async () => ({ binding, accountType: "business" }),
    resolveDefaultCaption: () => "Conheça a empresa sintética e acompanhe nosso conteúdo.",
    resolveSubmissionConnection: async grant => { assert.equal(isVerifiedCalendarSubmission(grant), true); return { binding, accountType: "business" }; } };
  let service = createCalendarSubmissions(options);
  const input = { assetId, uploadId, idempotencyKey: crypto.randomUUID(), expectedMediaRevision: 0, selection: chosen };
  return { context, input, store, options, grants, result, binding, preparation, service: () => service,
    remount() { service = createCalendarSubmissions({ ...options, grants: createCalendarGrants(key, clock) }); },
    ready() { prep = { assetId, uploadId, mediaRevision: 1, currentRevision: 1, state: "ready", ready: true }; },
    crash() { crashAfterPrepare = true; }, count: () => requested, advance: ms => { now += ms; },
    get: () => service.byKey(context, assetId, input.idempotencyKey),
    snapshot: () => store.update(context.companyId, state => state), progress: () => service.progress(context.companyId) };
}
test("accepted intent persists before preparation, recovers lost preparation response and finishes after remount without a preview request", async () => {
  const f = await fixture(), accepted = await f.service().request(f.context, f.input);
  assert.equal(accepted.state, "accepted"); assert.equal(accepted.caption, f.options.resolveDefaultCaption()); assert.equal(f.count(), 0);
  f.crash(); await f.progress(); assert.equal(f.count(), 1); assert.equal((await f.get()).state, "accepted");
  f.remount(); await f.progress(); assert.equal(f.count(), 1); assert.equal((await f.get()).state, "preparing");
  f.ready(); f.remount(); await Promise.all([f.progress(), f.progress()]);
  const done = await f.get(), state = await f.snapshot(), job = state.jobs[accepted.id];
  assert.equal(done.state, "scheduled"); assert.equal(done.calendarItemId, accepted.id); assert.equal(Object.keys(state.jobs).length, 1);
  assert.equal(job.caption, accepted.caption); assert.equal(job.automaticEnabled, true); assert.equal(job.import.previewDigest, f.result.previewDigest);
  assert.equal(Object.hasOwn(job.import, "confirmed"), false); assert.match(done.notice.id, /^calendar-ready-/);
});
test("concurrent duplicate acceptance and response recovery keep one reserved slot and never undo edit/pause/cancel", async () => {
  const f = await fixture(), receipts = await Promise.all(Array.from({ length: 8 }, () => f.service().request(f.context, f.input)));
  assert.equal(new Set(receipts.map(row => row.id)).size, 1);
  const second = await f.service().request(f.context, { ...f.input, idempotencyKey: crypto.randomUUID() });
  assert.notEqual(second.date, receipts[0].date);
  await f.progress(); f.ready(); await f.progress();
  await f.store.update(f.context.companyId, state => { const job = state.jobs[receipts[0].id];
    changeJob(state, job.id, { action: "caption", caption: "Editada", revision: job.revision }, f.options.clock());
    changeJob(state, job.id, { action: "automatic", enabled: false, revision: job.revision }, f.options.clock());
    changeJob(state, job.id, { action: "cancel", revision: job.revision }, f.options.clock());
  });
  const replay = await f.service().request(f.context, f.input); assert.equal(replay.state, "cancelled"); assert.equal(replay.caption, "Editada");
  await f.progress(); assert.equal((await f.snapshot()).jobs[replay.id].automaticEnabled, false);
  await assert.rejects(f.service().request(f.context, { ...f.input, caption: "Outra" }), { code: "calendar_import_submission_idempotency_conflict" });
});
test("pending cancellation, changed preference and source tampering cannot create an authorized publication", async () => {
  const cancelled = await fixture(), accepted = await cancelled.service().request(cancelled.context, cancelled.input);
  await cancelled.store.update(cancelled.context.companyId, state => { state.importSubmissions[accepted.id].state = "cancelled"; });
  await cancelled.progress(); assert.equal(cancelled.count(), 0); assert.equal(Object.keys((await cancelled.snapshot()).jobs).length, 0);
  const revoked = await fixture(); await revoked.service().request(revoked.context, revoked.input); await revoked.progress(); revoked.ready();
  await revoked.store.update(revoked.context.companyId, state => { state.preferences.enabled = false; state.preferences.revision++; });
  await revoked.progress(); assert.equal(Object.values((await revoked.snapshot()).jobs)[0].authorization, null);
  const changed = await fixture(); await changed.service().request(changed.context, changed.input); await changed.progress(); changed.ready();
  changed.result.objects.feed.sha256 = hash("tampered"); await changed.progress();
  assert.equal((await changed.get()).state, "attention"); assert.equal(Object.keys((await changed.snapshot()).jobs).length, 0);
});
test("same prepared selection is reused without another preparation, stale dates roll forward, and other owners cannot recover receipts", async () => {
  const f = await fixture(); f.ready();
  const input = { ...f.input, expectedMediaRevision: 1 }; await f.service().request(f.context, input);
  f.advance(3 * 86400000); await f.progress(); assert.equal(f.count(), 0);
  const done = await f.get(); assert.equal(done.state, "scheduled"); assert.ok(dateTime(done.date, done.time) > f.options.clock());
  await assert.rejects(f.service().byKey({ ...f.context, userId: crypto.randomUUID() }, input.assetId, input.idempotencyKey));
});
test("submission delegation is purpose separated, signed, owner-bound and emitted with a moving clock", () => {
  let now = 1000000; const grants = createCalendarGrants(crypto.randomBytes(32), () => now++);
  const companyId = crypto.randomUUID(), userId = crypto.randomUUID(), envelope = grants.issueSubmission({ companyId, userId,
    submissionId: "a".repeat(40), requestHash: "b".repeat(64) });
  const delegated = grants.verifySubmission(envelope, companyId, userId);
  assert.equal(isVerifiedCalendarSubmission(delegated), true); assert.equal(isVerifiedCalendarGrant(delegated), false);
  assert.equal(grants.verify(envelope, companyId, userId), null);
  assert.equal(grants.verifySubmission(envelope, companyId, crypto.randomUUID()), null);
  assert.equal(grants.verifySubmission(envelope.slice(0, -1) + (envelope.endsWith("0") ? "1" : "0"), companyId, userId), null);
  const auth = createSocialAuthAdapter(); assert.equal(auth.fromVerifiedCalendarSubmission(delegated).audience, "calendar_import_submission");
  assert.throws(() => auth.fromVerifiedCalendarSubmission({ ...delegated })); assert.throws(() => auth.fromVerifiedCalendarGrant(delegated));
});

test("default caption resolves once for concurrent acceptance and remains immutable after profile changes and remount", async () => {
  const f = await fixture(); let calls = 0, text = "Conheça a iA4tube e veja como organizar o conteúdo da sua empresa.\n#ia4tube";
  f.options.resolveDefaultCaption = context => { assert.equal(context, f.context); calls++; return text; }; f.remount();
  const receipts = await Promise.all(Array.from({ length: 6 }, () => f.service().request(f.context, f.input)));
  assert.equal(calls, 1); assert.ok(receipts.every(value => value.caption === text));
  text = "Outra descrição posterior"; f.remount();
  assert.equal((await f.service().request(f.context, f.input)).caption, receipts[0].caption); assert.equal(calls, 1);
  await f.progress(); f.ready(); await f.progress();
  assert.equal((await f.snapshot()).jobs[receipts[0].id].caption, receipts[0].caption); assert.equal(calls, 1);
});

test("explicit captions including intentional blank and original art captions bypass the institutional fallback", async () => {
  for (const supplied of ["Legenda escolhida pelo cliente", ""]) {
    const f = await fixture(); f.options.resolveDefaultCaption = () => assert.fail("explicit caption must not resolve profile"); f.remount();
    const result = await f.service().request(f.context, { ...f.input, caption: supplied }); assert.equal(result.caption, supplied);
  }
  for (const originalCaption of ["Legenda da arte já criada", ""]) {
    const f = await fixture(), originalId = "e".repeat(40);
    await f.store.update(f.context.companyId, state => {
      state.jobs[originalId] = { id: originalId, caption: originalCaption, date: "2026-09-24", time: "18:00", scheduledAt: dateTime("2026-09-24", "18:00"), phase: "ready" };
      state.importedSources = { origins: { [f.input.assetId]: { calendarItemId: originalId } } };
    });
    f.options.resolveDefaultCaption = () => assert.fail("art caption must not resolve profile"); f.remount();
    const result = await f.service().request(f.context, f.input); assert.equal(result.caption, originalCaption);
    assert.equal(result.date, "2026-09-25"); assert.equal(result.time, "18:00");
    assert.equal((await f.snapshot()).jobs[originalId].caption, originalCaption);
  }
});

test("missing or invalid default-caption authority refuses acceptance without preparation or a partial intention", async () => {
  for (const resolver of [null, () => "", () => { throw Object.assign(new Error("private details"), { code: "calendar_import_submission_caption_owner_unavailable", statusCode: 503 }); }]) {
    const f = await fixture(); f.options.resolveDefaultCaption = resolver; f.remount();
    await assert.rejects(f.service().request(f.context, f.input), { code: "calendar_import_submission_caption_owner_unavailable" });
    assert.equal(f.count(), 0); assert.equal(Object.keys((await f.snapshot()).importSubmissions || {}).length, 0);
  }
});
