"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"),
  os = require("node:os"), crypto = require("node:crypto");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { admissionOrderId, hash } = require("../src/company-edit-calendar/admission-contract");
const billing = require("../src/billing/billing.service"), plans = require("../src/billing/plans");
const planning = require("../src/company-monthly-planning/planning.service");
const { atomicWriteJson } = require("../src/notifications/fcm-token-store");
const syntheticSecret = "synthetic-media-quota-only-key-not-a-real-credential";
const healthy = { provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "123456789012345" };

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-30T12:00:00Z") });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-media-quota-test-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = "synthetic-media-owner", clientsFile = path.join(root, "clients.json");
  const client = { ativo: true, nome_empresa: "Loja sintetica", ramo: "Loja", arte_gratis_disponivel: false, arte_gratis_usada: true,
    artes_avulsas_restantes: 0 };
  billing.applyManualPlanPayment(client, plans.getPlan(options.legacy ? "i4_essencial" : "i4_combo_10i_4v_v1"), "synthetic-payment-1", new Date());
  Object.assign(client, options.client);
  atomicWriteJson(clientsFile, { [owner]: client });
  const calls = { writes: 0, observe: 0, receipt: 0 };
  const readClients = () => JSON.parse(fs.readFileSync(clientsFile, "utf8"));
  const writeClients = value => { calls.writes++; atomicWriteJson(clientsFile, value); };
  const dependencies = { dataDir: root, planningDir: path.join(root, "planning"), ordersDir: path.join(root, "orders"), secret: syntheticSecret,
    readClients, writeClients, prepareCalendarRequest: async () => null, admissionEnabled: true, clock: () => Date.now(),
    observeConnection: async () => { calls.observe++; return healthy; }, recordFreeArtUse: () => { calls.receipt++; return true; }, ...options.ports };
  const service = createEditCalendarService(dependencies); t.after(() => service.close());
  const claims = { whatsapp: owner, sub: owner, company_id: owner, token_version: 2, iss: "ia4tube-api", aud: "ia4tube-client", jti: crypto.randomUUID() };
  async function request(kind = "video") {
    const context = await service.createContext(claims, { requestId: crypto.randomUUID(), date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
      time: "14:00", destination: "reel" });
    return { schemaVersion: 1, ticket: context.ticket, editOrderId: admissionOrderId(context.ticket), requestHash: hash(crypto.randomUUID()),
      mediaKind: kind, title: "Modelo sintetico", caption: "Legenda sintetica", durationSeconds: kind === "image" ? null : 10,
      selection: { modelId: crypto.randomUUID(), modelVersion: 1, sourceDigest: hash("synthetic-media-source") }, quantity: 1 };
  }
  const bind = input => service.bind({ ticket: input.ticket, editOrderId: input.editOrderId, title: input.title, caption: input.caption,
    mediaKind: input.mediaKind, durationSeconds: input.durationSeconds, inputHash: hash(`producer:${input.editOrderId}`) });
  const cancel = input => service.cancelAdmission({ schemaVersion: 1, ticket: input.ticket, editOrderId: input.editOrderId,
    requestHash: input.requestHash, reason: "upload_unavailable" });
  const row = input => JSON.parse(fs.readFileSync(path.join(root, "private/edit-calendar/contexts", input.ticket.slice(0, 36) + ".json"), "utf8"));
  const current = () => readClients()[owner];
  function patch(value) { const clients = readClients(); Object.assign(clients[owner], value); writeClients(clients); }
  function activate(planId = "i4_combo_15i_6v_v1", paymentId = "synthetic-payment-2") {
    const clients = readClients(); billing.applyManualPlanPayment(clients[owner], plans.getPlan(planId), paymentId, new Date()); writeClients(clients);
  }
  return { root, owner, claims, service, calls, dependencies, readClients, writeClients, request, bind, cancel, row, current, patch, activate };
}

function balances(client) {
  return { image: client.artes_mensais_restantes, imageUsed: client.artes_mensais_usadas,
    video: client.videos_mensais_restantes, videoUsed: client.videos_mensais_usados, standalone: client.artes_avulsas_restantes };
}
function childCount(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => sum +
    (entry.isDirectory() ? childCount(path.join(directory, entry.name)) : Number(entry.name === "pedido.json")), 0);
}
async function readOnlyHint(f) {
  const before = fs.readFileSync(path.join(f.root, "clients.json")), writes = f.calls.writes, attempted = [], originals = new Map();
  for (const name of ["mkdirSync", "writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync", "truncateSync", "writeSync", "chmodSync", "chownSync"]) {
    originals.set(name, fs[name]); fs[name] = () => { attempted.push(name); throw new Error("availability must not write"); };
  }
  const open = fs.openSync;
  fs.openSync = (file, flags, ...rest) => {
    if (typeof flags === "string" ? /[wa+]/.test(flags) : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0) {
      attempted.push("open-write"); throw new Error("availability must not open for write");
    }
    return open(file, flags, ...rest);
  };
  let result;
  try { result = await f.service.availability(f.claims); }
  finally { for (const [name, original] of originals) fs[name] = original; fs.openSync = open; }
  assert.deepEqual(attempted, []); assert.deepEqual(fs.readFileSync(path.join(f.root, "clients.json")), before);
  assert.equal(f.calls.writes, writes); assert.equal(f.calls.receipt, 0);
  assert.deepEqual(Object.keys(result.availability).sort(), ["canImage", "canVideo", "observedAt", "schemaVersion", "validUntil"]);
  assert.equal(result.availability.schemaVersion, 1); assert.equal(result.availability.validUntil, result.availability.observedAt + 30000);
  return result.availability;
}

for (const plan of plans.listPlans()) test(`new combo ${plan.id} reserves only the selected monthly format`, async t => {
  const f = fixture(t); f.activate(plan.id, "synthetic-plan-specific");
  const initial = balances(f.current());
  await f.service.admit(await f.request("image"));
  assert.equal(f.current().artes_mensais_restantes, plan.imagesPerMonth - 1);
  assert.equal(f.current().videos_mensais_restantes, plan.videosPerMonth);
  if (plan.videosPerMonth) {
    await f.service.admit(await f.request("video"));
    assert.equal(f.current().artes_mensais_restantes, plan.imagesPerMonth - 1);
    assert.equal(f.current().videos_mensais_restantes, plan.videosPerMonth - 1);
  } else await assert.rejects(f.service.admit(await f.request("video")), { code: "billing_required" });
  assert.equal(initial.image, plan.imagesPerMonth); assert.equal(initial.video, plan.videosPerMonth);
  assert.equal(childCount(f.dependencies.ordersDir), 0);
});

test("exhausting four videos preserves all ten images and refuses another video", async t => {
  const f = fixture(t), requests = [];
  for (let i = 0; i < 4; i++) { const input = await f.request(); requests.push(input); await f.service.admit(input); }
  assert.deepEqual(balances(f.current()), { image: 10, imageUsed: 0, video: 0, videoUsed: 4, standalone: 0 });
  await assert.rejects(f.service.admit(await f.request()), { code: "billing_required" });
  const receipt = await f.service.admit(requests[0]); assert.equal(receipt.admission.state, "reserved");
  assert.equal(f.current().videos_mensais_restantes, 0);
  const hint = await readOnlyHint(f); assert.equal(hint.canImage, true); assert.equal(hint.canVideo, false);
});

test("exhausting ten images preserves all four videos and refuses another image", async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) await f.service.admit(await f.request("image"));
  assert.deepEqual(balances(f.current()), { image: 0, imageUsed: 10, video: 4, videoUsed: 0, standalone: 0 });
  await assert.rejects(f.service.admit(await f.request("image")), { code: "billing_required" });
  const hint = await readOnlyHint(f); assert.equal(hint.canImage, false); assert.equal(hint.canVideo, true);
});

test("one concurrent image and video use independent last units", async t => {
  const f = fixture(t, { client: { artes_mensais_restantes: 1, artes_mensais_usadas: 9, videos_mensais_restantes: 1, videos_mensais_usados: 3 } });
  const inputs = [await f.request("image"), await f.request("video")];
  await Promise.all(inputs.map(input => f.service.admit(input)));
  assert.deepEqual(balances(f.current()), { image: 0, imageUsed: 10, video: 0, videoUsed: 4, standalone: 0 });
});

test("competing requests cannot overdraw the last video or borrow images", async t => {
  const f = fixture(t, { client: { videos_mensais_restantes: 1, videos_mensais_usados: 3 } }), inputs = [];
  for (let i = 0; i < 8; i++) inputs.push(await f.request());
  const results = await Promise.allSettled(inputs.map(input => f.service.admit(input)));
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  for (const value of results.filter(value => value.status === "rejected")) assert.equal(value.reason.code, "billing_required");
  assert.deepEqual(balances(f.current()), { image: 10, imageUsed: 0, video: 0, videoUsed: 4, standalone: 0 });
});

test("concurrent exact retries persist one typed allocation without creating a child", async t => {
  const f = fixture(t), input = await f.request();
  const receipts = await Promise.all(Array.from({ length: 8 }, () => f.service.admit(input)));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  const row = f.row(input); assert.equal(row.admission.reservation.monthly, 0); assert.equal(row.admission.reservation.monthlyVideo, 1);
  assert.equal(row.admission.reservation.mediaQuota.mediaKind, "video");
  assert.equal(row.admission.reservation.mediaQuota.grantRef.grantId, f.current().plano_cotas_concessao_id);
  assert.equal(f.current().videos_mensais_restantes, 3); assert.equal(f.current().artes_mensais_restantes, 10);
  assert.equal(childCount(f.dependencies.ordersDir), 0);
});

test("changing the format of an admitted attempt cannot take a second pool", async t => {
  const f = fixture(t), input = await f.request(); await f.service.admit(input); const before = balances(f.current());
  await assert.rejects(f.service.admit({ ...input, mediaKind: "image", durationSeconds: null }), { code: "edit_calendar_admission_conflict" });
  assert.deepEqual(balances(f.current()), before);
});

test("video bind freezes the producer hash once and never consumes an internal image", async t => {
  const f = fixture(t), input = await f.request(), receipt = await f.service.admit(input), before = balances(f.current());
  const first = f.bind(input); assert.deepEqual(f.bind(input), first); assert.equal(first.pedidoId, receipt.admission.pedidoId);
  assert.deepEqual(balances(f.current()), before); assert.equal(childCount(f.dependencies.ordersDir), 1);
  const child = planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: first.pedidoId });
  assert.equal(child.pedido.edit_calendar.mediaKind, "video"); assert.equal(child.pedido.edit_calendar.inputHash, hash(`producer:${input.editOrderId}`));
  assert.equal(f.current().planejamento_mensal_videos_reservados, 0);
  assert.equal((await f.service.admit(input)).admission.state, "bound");
});

test("classic video bind omitting mediaKind keeps its typed video reservation", async t => {
  const f = fixture(t), input = await f.request(); await f.service.admit(input);
  const body = { ticket: input.ticket, editOrderId: input.editOrderId, title: input.title, caption: input.caption,
    durationSeconds: input.durationSeconds, inputHash: hash("synthetic-classic-producer") };
  const result = f.service.bind(body); assert.deepEqual(f.service.bind(body), result);
  assert.equal(f.current().videos_mensais_restantes, 3); assert.equal(f.current().artes_mensais_restantes, 10);
  assert.equal(Object.hasOwn(f.row(input).binding, "mediaKind"), false); assert.equal(childCount(f.dependencies.ordersDir), 1);
});

test("an interrupted typed producer bind resumes its frozen hash without another unit or parallel child", async t => {
  let interrupted = false;
  const f = fixture(t, { ports: { fault(name) { if (name === "after_request" && !interrupted) { interrupted = true; throw new Error("synthetic bind interruption"); } } } });
  const input = await f.request(); await f.service.admit(input); const before = balances(f.current());
  assert.throws(() => f.bind(input), /synthetic bind interruption/);
  const frozen = f.row(input).binding; assert.equal(frozen.inputHash, hash(`producer:${input.editOrderId}`));
  f.bind(input); assert.deepEqual(f.row(input).binding, frozen); assert.deepEqual(balances(f.current()), before);
  assert.equal(childCount(f.dependencies.ordersDir), 1);
});

for (const kind of ["image", "video"]) test(`cancelling ${kind} refunds only its original monthly pool once`, async t => {
  const f = fixture(t), initial = balances(f.current()), input = await f.request(kind); await f.service.admit(input);
  const first = f.cancel(input); assert.equal(first.admission.state, "cancelled"); assert.deepEqual(f.cancel(input), first);
  assert.deepEqual(balances(f.current()), initial); assert.equal(childCount(f.dependencies.ordersDir), 0);
  await assert.rejects(f.service.admit(input), { code: "edit_calendar_admission_conflict" });
});

test("cancellation after bind cannot refund a typed video", async t => {
  const f = fixture(t), input = await f.request(); await f.service.admit(input); f.bind(input); const before = balances(f.current());
  assert.throws(() => f.cancel(input), { code: "edit_calendar_admission_not_cancellable" }); assert.deepEqual(balances(f.current()), before);
});

for (const point of ["admission_after_request", "admission_after_client_commit"]) test(`video admission recovers ${point} without double debit`, async t => {
  let interrupted = false;
  const f = fixture(t, { ports: { fault(name) { if (name === point && !interrupted) { interrupted = true; throw new Error("synthetic interruption"); } } } });
  const input = await f.request(); await assert.rejects(f.service.admit(input), /synthetic interruption/);
  const receipt = await f.service.admit(input); assert.equal(receipt.admission.editOrderId, input.editOrderId);
  assert.deepEqual(balances(f.current()), { image: 10, imageUsed: 0, video: 3, videoUsed: 1, standalone: 0 });
  assert.equal(childCount(f.dependencies.ordersDir), 0);
});

for (const point of ["admission_cancel_after_journal", "admission_cancel_after_client_commit"]) test(`video refund recovers ${point} exactly once`, async t => {
  let interrupted = false;
  const f = fixture(t, { ports: { fault(name) { if (name === point && !interrupted) { interrupted = true; throw new Error("synthetic interruption"); } } } });
  const input = await f.request(); await f.service.admit(input); assert.throws(() => f.cancel(input), /synthetic interruption/);
  assert.equal(f.cancel(input).admission.state, "cancelled");
  assert.deepEqual(balances(f.current()), { image: 10, imageUsed: 0, video: 4, videoUsed: 0, standalone: 0 });
});

test("the reconciliation digest detects a video-only change before recovering an uncommitted admission", async t => {
  let interrupted = false;
  const f = fixture(t, { ports: { fault(name) { if (name === "admission_after_request" && !interrupted) { interrupted = true; throw new Error("synthetic interruption"); } } } });
  const input = await f.request(); await assert.rejects(f.service.admit(input), /synthetic interruption/);
  f.patch({ videos_mensais_restantes: 3, videos_mensais_usados: 1 }); const before = f.current();
  await assert.rejects(f.service.admit(input), { code: "edit_calendar_allocation_reconciliation_required" });
  assert.deepEqual(f.current(), before);
});

test("a paid video binds after an upgrade in the same month without touching the new grant", async t => {
  const f = fixture(t), input = await f.request(); await f.service.admit(input); const originalGrant = f.row(input).admission.reservation.mediaQuota.grantRef;
  f.activate();
  f.patch({ planejamento_mensal_reservas: {}, planejamento_mensal_ciclo: f.current().plano_ciclo });
  const before = balances(f.current()); assert.notEqual(f.current().plano_cotas_concessao_id, originalGrant.grantId);
  const result = f.bind(input); assert.deepEqual(f.bind(input), result); assert.deepEqual(balances(f.current()), before);
  assert.deepEqual(f.row(input).admission.reservation.mediaQuota.grantRef, originalGrant); assert.equal(childCount(f.dependencies.ordersDir), 1);
});

test("an upgrade in the same month cannot refund a video into the new grant", async t => {
  const f = fixture(t), input = await f.request(); await f.service.admit(input); f.activate(); const before = f.current();
  assert.throws(() => f.cancel(input), { code: "billing_media_quota_grant_changed" }); assert.deepEqual(f.current(), before);
});

test("an expired ticket with a paid prior-cycle video still binds without a new-cycle debit", async t => {
  const f = fixture(t), input = await f.request(); await f.service.admit(input);
  t.mock.timers.tick(32 * 86400000); f.activate("i4_combo_10i_4v_v1", "synthetic-next-cycle");
  const before = balances(f.current()); assert.notEqual(f.row(input).admission.reservation.cycle, f.current().plano_ciclo);
  assert.equal((await f.service.admit(input)).admission.state, "reserved"); f.bind(input);
  assert.deepEqual(balances(f.current()), before); assert.equal(childCount(f.dependencies.ordersDir), 1);
});

test("a prior-cycle video cannot mint a refund in the new cycle", async t => {
  const f = fixture(t), input = await f.request(); await f.service.admit(input);
  t.mock.timers.tick(32 * 86400000); f.activate("i4_combo_10i_4v_v1", "synthetic-next-cycle"); const before = f.current();
  assert.throws(() => f.cancel(input), { code: "edit_calendar_allocation_reconciliation_required" }); assert.deepEqual(f.current(), before);
});

test("legacy shared accounts and already charged legacy orders keep their original allocation", async t => {
  const f = fixture(t, { legacy: true }), input = await f.request(), initial = f.current().artes_mensais_restantes;
  await f.service.admit(input); assert.equal(f.current().artes_mensais_restantes, initial - 1);
  assert.deepEqual(Object.keys(f.row(input).admission.reservation).sort(), ["cycle", "free", "monthly", "standalone"]);
  f.activate("i4_combo_10i_4v_v1"); const before = balances(f.current()); f.bind(input); assert.deepEqual(balances(f.current()), before);
  assert.equal(f.row(input).admission.reservation.monthly, 1); assert.equal(Object.hasOwn(f.row(input).admission.reservation, "mediaQuota"), false);
});

test("legacy standalone units remain shared extras and are not duplicated into the video pool", async t => {
  const f = fixture(t, { client: { artes_mensais_restantes: 0, artes_mensais_usadas: 10, videos_mensais_restantes: 0,
    videos_mensais_usados: 4, artes_avulsas_restantes: 1 } });
  const hint = await readOnlyHint(f); assert.equal(hint.canImage, true); assert.equal(hint.canVideo, true);
  const input = await f.request(); await f.service.admit(input);
  assert.equal(f.current().artes_avulsas_restantes, 0); assert.equal(f.row(input).admission.reservation.standalone, 1);
  assert.equal(f.row(input).admission.reservation.monthlyVideo, 0); assert.equal(f.current().videos_mensais_restantes, 0);
  await assert.rejects(f.service.admit(await f.request("image")), { code: "billing_required" });
  f.cancel(input); assert.equal(f.current().artes_avulsas_restantes, 1); assert.equal(f.current().videos_mensais_restantes, 0);
});

test("video monthly quota precedes the historical shared standalone extra", async t => {
  const f = fixture(t, { client: { videos_mensais_restantes: 1, videos_mensais_usados: 3, artes_avulsas_restantes: 1 } });
  await f.service.admit(await f.request()); assert.equal(f.current().videos_mensais_restantes, 0); assert.equal(f.current().artes_avulsas_restantes, 1);
  await f.service.admit(await f.request()); assert.equal(f.current().artes_avulsas_restantes, 0); assert.equal(f.current().artes_mensais_restantes, 10);
});

test("the confirmed Instagram image remains an image gift and never finances a video", async t => {
  const f = fixture(t, { client: { artes_mensais_restantes: 0, artes_mensais_usadas: 10, videos_mensais_restantes: 0,
    videos_mensais_usados: 4, arte_gratis_usada: false } });
  const hint = await readOnlyHint(f); assert.equal(hint.canImage, true); assert.equal(hint.canVideo, false);
  await assert.rejects(f.service.admit(await f.request()), { code: "billing_required" });
  const input = await f.request("image"); await f.service.admit(input);
  assert.equal(f.row(input).admission.reservation.free, 1); assert.equal(f.current().arte_gratis_usada, true);
  assert.equal(f.current().videos_mensais_restantes, 0); assert.equal(f.current().artes_mensais_restantes, 0);
});

for (const [image, video, canImage, canVideo] of [[10, 4, true, true], [10, 0, true, false], [0, 4, false, true], [0, 0, false, false]])
  test(`read-only five-field availability distinguishes image=${image} video=${video}`, async t => {
    const f = fixture(t, { client: { artes_mensais_restantes: image, artes_mensais_usadas: 10 - image,
      videos_mensais_restantes: video, videos_mensais_usados: 4 - video } });
    const hint = await readOnlyHint(f); assert.equal(hint.canImage, canImage); assert.equal(hint.canVideo, canVideo); assert.equal(f.calls.observe, 0);
  });

test("an Instagram read failure leaves only the unpaid image unknown, preserving paid video availability", async t => {
  const f = fixture(t, { client: { artes_mensais_restantes: 0, artes_mensais_usadas: 10, arte_gratis_usada: false },
    ports: { observeConnection: async () => { throw new Error("synthetic observation failure"); } } });
  const hint = await readOnlyHint(f); assert.equal(hint.canImage, null); assert.equal(hint.canVideo, true);
});

test("observing an expired typed cycle never writes or enables either monthly balance", async t => {
  const f = fixture(t, { client: { plano_renova_em: "2020-01-01" } });
  const hint = await readOnlyHint(f); assert.equal(hint.canImage, false); assert.equal(hint.canVideo, false);
  assert.equal(f.current().artes_mensais_restantes, 10); assert.equal(f.current().videos_mensais_restantes, 4);
});

test("malformed typed counters produce unknown availability without granting or normalizing persisted data", async t => {
  const f = fixture(t, { client: { videos_mensais_restantes: -1 } });
  const hint = await readOnlyHint(f); assert.equal(hint.canImage, null); assert.equal(hint.canVideo, null);
  assert.equal(f.current().videos_mensais_restantes, -1);
});

test("ordinary monthly planning reserves and cancels only image quota", t => {
  const f = fixture(t), client = f.current();
  const result = planning.createRequest({ baseDir: f.dependencies.planningDir, whatsapp: f.owner, cliente: client,
    body: { quantidade_reservada: 3, mediaKind: "video" }, files: {}, freeArtBlocked: true });
  assert.equal(client.artes_mensais_restantes, 7); assert.equal(client.artes_mensais_usadas, 3); assert.equal(client.videos_mensais_restantes, 4);
  assert.equal(result.reserva.media_quota.mediaKind, "image");
  planning.cancelPlanning({ baseDir: f.dependencies.planningDir, whatsapp: f.owner, planningId: result.planejamento_id, cliente: client });
  assert.equal(client.artes_mensais_restantes, 10); assert.equal(client.artes_mensais_usadas, 0); assert.equal(client.videos_mensais_restantes, 4);
});
