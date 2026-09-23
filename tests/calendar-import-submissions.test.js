"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createCalendarSubmissions, validateCalendarSubmissions } = require("../src/social/calendar/imports/calendar-submissions");
const { createCalendarGrants, isVerifiedCalendarSubmission, isVerifiedCalendarGrant } = require("../src/social/calendar/grants");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createLocalCalendarSimulationStore } = require("../src/social/calendar/imports/local-calendar-simulation");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const { publicationPlan, previewDigest, selection } = require("../src/social/calendar/imports/policy");
const { dateTime, changeJob } = require("../src/social/calendar/model");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
async function fixture(owner = null) {
  const context = owner || { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() }, assetId = crypto.randomUUID(), uploadId = crypto.randomUUID();
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
async function httpFixture(t) {
  const express = require("express"), jwt = require("jsonwebtoken");
  const { createProductionSession, ISSUER, AUDIENCE } = require("../src/social/production-session");
  const { createCalendarImportRouter } = require("../src/social/calendar/imports/router");
  const { createPrivateImportPreviewRouter } = require("../src/social/calendar/imports/preview-router");
  const secret = crypto.randomBytes(40).toString("hex"), clients = { "synthetic-a": { ativo: true }, "synthetic-b": { ativo: true } };
  const session = createProductionSession({ secret, readClients: () => clients });
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "synthetic-http-v1" });
  const token = session.sign("synthetic-a"), claims = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
  const principal = auth.fromVerifiedJwt(claims);
  const f = await fixture({ authenticated: true, companyId: principal.companyId, userId: principal.userId });
  const facade = { ready: true, allowed: context => context.companyId === f.context.companyId && context.userId === f.context.userId,
    canAdmit: () => true, submissions: f.service() };
  const app = express(), prefix = "/v1/social/calendar/imports", resolvePrincipal = value => auth.fromVerifiedJwt(value);
  // Same parser/router order as production, including preview pass-through.
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use(prefix, createPrivateImportPreviewRouter({ authenticate: session.authenticate, resolvePrincipal, getService: () => null, getScheduledService: () => null }));
  app.use(prefix, createCalendarImportRouter({ authenticate: session.authenticate, resolvePrincipal, getService: () => facade }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}${prefix}`, route = `/assets/${f.input.assetId}/calendar-submissions`;
  const request = (path, data, selectedToken = token) => fetch(base + path, { method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(selectedToken ? { Authorization: `Bearer ${selectedToken}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const { assetId: _pathOnly, ...input } = f.input;
  return { ...f, route, input, request, otherToken: session.sign("synthetic-b") };
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

test("chosen date and time survive acceptance, restart and final calendar insertion without a preview step", async () => {
  const f = await fixture(), schedule = { date: "2026-09-24", time: "18:35", timeZone: "America/Sao_Paulo" };
  const input = { ...f.input, schedule }, accepted = await f.service().request(f.context, input);
  assert.equal(accepted.date, schedule.date); assert.equal(accepted.time, schedule.time);
  assert.equal(f.count(), 0);
  const pending = JSON.parse(JSON.stringify(await f.snapshot()));
  assert.deepEqual(pending.importSubmissions[accepted.id].request.schedule, schedule);
  validateCalendarSubmissions(pending);
  f.remount(); await f.progress(); f.ready(); f.remount(); await f.progress();
  const done = await f.get(), job = (await f.snapshot()).jobs[accepted.id];
  assert.equal(done.state, "scheduled"); assert.equal(done.calendarItemId, accepted.id);
  assert.equal(job.date, schedule.date); assert.equal(job.time, schedule.time);
  assert.equal(job.scheduledAt, dateTime(schedule.date, schedule.time));
  assert.equal(job.caption, accepted.caption); assert.equal(f.count(), 1);
  validateCalendarSubmissions(JSON.parse(JSON.stringify(await f.snapshot())));
});

test("schedule participates in idempotency while omitted timezone normalizes to the existing calendar timezone", async () => {
  const f = await fixture(), schedule = { date: "2026-09-25", time: "16:10" };
  const accepted = await f.service().request(f.context, { ...f.input, schedule });
  const normalized = await f.service().request(f.context, { ...f.input, schedule: { ...schedule, timeZone: "America/Sao_Paulo" } });
  assert.equal(normalized.id, accepted.id);
  for (const changed of [undefined, { ...schedule, time: "17:10" }, { ...schedule, date: "2026-09-26" }]) {
    await assert.rejects(f.service().request(f.context, { ...f.input, schedule: changed }), { code: "calendar_import_submission_idempotency_conflict" });
  }
  assert.equal(Object.keys((await f.snapshot()).importSubmissions).length, 1); assert.equal(f.count(), 0);
});

test("legacy omitted/null schedules retain the pre-update client hash and default allocation", async () => {
  const f = await fixture(), accepted = await f.service().request(f.context, f.input);
  const replay = await f.service().request(f.context, { ...f.input, schedule: null });
  assert.equal(replay.id, accepted.id); assert.equal(replay.date, "2026-09-24"); assert.equal(replay.time, "09:00");
  const row = (await f.snapshot()).importSubmissions[accepted.id];
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const expected = hash(JSON.stringify(canonical([f.input.assetId, f.input.uploadId, f.input.idempotencyKey,
    f.input.expectedMediaRevision, f.input.selection, null])));
  assert.equal(row.clientHash, expected); assert.equal(Object.hasOwn(row.request, "schedule"), false);
});

test("invalid, unsupported and partial schedules never create an intention or preparation", async () => {
  for (const schedule of [[], "2026-09-24", {}, { date: "2026-09-24" }, { time: "18:00" },
    { date: "2026-02-30", time: "18:00" }, { date: "2026-09-24", time: "24:00" },
    { date: "2026-09-24", time: "18:00", timeZone: "UTC" },
    { date: "2026-09-24", time: "18:00", timeZone: null },
    { date: "2026-09-24", time: "18:00", companyId: crypto.randomUUID() }]) {
    const f = await fixture();
    await assert.rejects(f.service().request(f.context, { ...f.input, schedule }), { code: "calendar_import_submission_schedule_invalid", statusCode: 400 });
    assert.equal(Object.keys((await f.snapshot()).importSubmissions || {}).length, 0); assert.equal(f.count(), 0);
  }
  for (const schedule of [{ date: "2026-09-23", time: "12:00" }, { date: "2026-09-22", time: "18:00" }, { date: "2027-09-23", time: "18:00" }]) {
    const f = await fixture();
    await assert.rejects(f.service().request(f.context, { ...f.input, schedule }), { code: "calendar_import_submission_time_outside_window", statusCode: 400 });
    assert.equal(Object.keys((await f.snapshot()).importSubmissions || {}).length, 0); assert.equal(f.count(), 0);
  }
});

test("explicit occupied dates refuse instead of moving to another day, including another pending intention", async () => {
  const schedule = { date: "2026-09-24", time: "18:00" };
  for (const occupiedBy of ["job", "pending"]) {
    const f = await fixture();
    if (occupiedBy === "job") await f.store.update(f.context.companyId, state => {
      state.jobs["f".repeat(40)] = { id: "f".repeat(40), phase: "ready", scheduledAt: dateTime(schedule.date, schedule.time) };
    });
    else await f.service().request(f.context, { ...f.input, idempotencyKey: crypto.randomUUID(), schedule });
    await assert.rejects(f.service().request(f.context, { ...f.input, schedule }), { code: "calendar_import_submission_time_occupied" });
    assert.equal(f.count(), 0);
  }
});

test("an explicit schedule expiring during preparation becomes attention without new work or silent rescheduling", async () => {
  const f = await fixture(), schedule = { date: "2026-09-23", time: "12:01" }, input = { ...f.input, schedule };
  const accepted = await f.service().request(f.context, input);
  f.advance(60000); f.remount(); await f.progress();
  const done = await f.get(); assert.equal(done.id, accepted.id); assert.equal(done.state, "attention");
  assert.equal(done.errorCode, "calendar_import_submission_time_outside_window");
  assert.equal(done.date, schedule.date); assert.equal(done.time, schedule.time);
  assert.equal(f.count(), 0); assert.equal(Object.keys((await f.snapshot()).jobs).length, 0);
  assert.equal((await f.service().request(f.context, input)).id, accepted.id, "Recovery remains valid after chosen time passes");
});

test("a collision arising before finalization preserves the selected date and surfaces attention", async () => {
  const f = await fixture(), schedule = { date: "2026-09-24", time: "18:00" };
  await f.service().request(f.context, { ...f.input, schedule }); await f.progress(); f.ready();
  await f.store.update(f.context.companyId, state => {
    state.jobs["f".repeat(40)] = { id: "f".repeat(40), phase: "ready", scheduledAt: dateTime(schedule.date, schedule.time) };
  });
  await f.progress(); const done = await f.get();
  assert.equal(done.state, "attention"); assert.equal(done.errorCode, "calendar_import_submission_time_occupied");
  assert.equal(done.date, schedule.date); assert.equal(done.time, schedule.time);
  assert.equal(Object.keys((await f.snapshot()).jobs).length, 1);
});

test("recovery of a selected date preserves a later authorized calendar edit and other-owner isolation", async () => {
  const f = await fixture(), input = { ...f.input, schedule: { date: "2026-09-24", time: "18:00" } };
  f.ready(); input.expectedMediaRevision = 1;
  const accepted = await f.service().request(f.context, input); await f.progress();
  await f.store.update(f.context.companyId, state => {
    const job = state.jobs[accepted.id];
    changeJob(state, job.id, { action: "schedule", date: "2026-09-25", time: "10:20", revision: job.revision }, f.options.clock());
  });
  const replay = await f.service().request(f.context, input);
  assert.equal(replay.date, "2026-09-25"); assert.equal(replay.time, "10:20"); assert.equal(f.count(), 0);
  validateCalendarSubmissions(JSON.parse(JSON.stringify(await f.snapshot())));
  await assert.rejects(f.service().byKey({ ...f.context, userId: crypto.randomUUID() }, input.assetId, input.idempotencyKey));
  await assert.rejects(f.service().request({ ...f.context, companyId: crypto.randomUUID() }, input));
});

test("HTTP direct submission passes chosen schedule through the production router order into durable acceptance and receipt", async t => {
  const f = await httpFixture(t), schedule = { date: "2026-09-24", time: "18:35", timeZone: "America/Sao_Paulo" };
  const response = await f.request(f.route, { ...f.input, schedule }), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true);
  assert.equal(body.submission.date, schedule.date); assert.equal(body.submission.time, schedule.time);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await f.snapshot()).importSubmissions[body.submission.id].request.schedule, schedule);
  await f.progress(); f.ready(); await f.progress();
  const recovery = await f.request(`${f.route}/by-key/${f.input.idempotencyKey}`), recovered = await recovery.json();
  assert.equal(recovery.status, 200); assert.equal(recovered.submission.state, "scheduled");
  assert.equal(recovered.submission.calendarItemId, body.submission.id);
  assert.equal(recovered.submission.date, schedule.date); assert.equal(recovered.submission.time, schedule.time);
});

test("HTTP schedule refusals expose only specific safe JSON codes and preserve admission and owner protections", async t => {
  const f = await httpFixture(t), schedule = { date: "2026-09-24", time: "18:00" };
  const check = async (input, status, code) => {
    const response = await f.request(f.route, input), body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body)); assert.equal(body.ok, false); assert.equal(body.code, code);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "ok"]);
  };
  await check({ ...f.input, schedule: { ...schedule, timeZone: "UTC" } }, 400, "calendar_import_submission_schedule_invalid");
  await check({ ...f.input, schedule: { date: "2026-09-23", time: "12:00" } }, 400, "calendar_import_submission_time_outside_window");
  const accepted = await f.request(f.route, { ...f.input, schedule }); assert.equal(accepted.status, 200);
  await check({ ...f.input, idempotencyKey: crypto.randomUUID(), schedule }, 409, "calendar_import_submission_time_occupied");
  await check({ ...f.input, schedule: { ...schedule, time: "18:01" } }, 409, "calendar_import_submission_idempotency_conflict");
  await check({ ...f.input, schedule, companyId: crypto.randomUUID() }, 400, "import_request_invalid");
  assert.equal((await f.request(f.route, { ...f.input, schedule }, null)).status, 401);
  assert.equal((await f.request(f.route, { ...f.input, schedule }, f.otherToken)).status, 503);
  assert.equal((await f.request(`${f.route}/by-key/${f.input.idempotencyKey}`, undefined, f.otherToken)).status, 503);
  assert.equal(Object.keys((await f.snapshot()).importSubmissions).length, 1); assert.equal(f.count(), 0);
});
