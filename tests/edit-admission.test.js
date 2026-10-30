"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"),
  os = require("node:os"), crypto = require("node:crypto");
const express = require("express");
const { spawnSync } = require("node:child_process");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { createEditCalendarRouter } = require("../src/company-edit-calendar/router");
const { createAdmissionAuthentication, canonicalJson, admissionOrderId, hash, ADMIT_PATH, CANCEL_PATH } = require("../src/company-edit-calendar/admission-contract");
const { isAdmissionRequest, admissionJsonParser, admissionJsonError, createCapabilityRateGuard } = require("../src/company-edit-calendar/admission-http");
const { atomicWriteJson } = require("../src/notifications/fcm-token-store");
const planning = require("../src/company-monthly-planning/planning.service");
const billing = require("../src/billing/billing.service");
const secret = "synthetic-edit-admission-secret-not-a-real-credential";
const rpcSecret = "synthetic-scoped-cloud-receiver-key-not-a-real-credential";
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-admission-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = "synthetic-owner", other = "synthetic-other", clientsFile = path.join(root, "clients.json");
  const client = { ativo: true, nome_empresa: "Loja sintetica", ramo: "Loja", plano_status: "active", plano_renova_em: "2099-01-01",
    plano_ciclo: new Date().toISOString().slice(0, 7), artes_mensais_total: 2, artes_mensais_restantes: 2, artes_avulsas_restantes: 0 };
  atomicWriteJson(clientsFile, { [owner]: { ...client, ...options.client }, [other]: { ...client, ...options.client } });
  const readClients = () => JSON.parse(fs.readFileSync(clientsFile, "utf8"));
  const writeClients = value => atomicWriteJson(clientsFile, value);
  let now = Date.now(), observations = 0;
  let connection = { provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "123456789012345" };
  const dependencies = { dataDir: root, planningDir: path.join(root, "planning"), ordersDir: path.join(root, "orders"), secret,
    readClients, writeClients, prepareCalendarRequest: async () => null, admissionEnabled: true,
    clock: () => now, observeConnection: async () => { observations++; return connection; }, ...options };
  const service = createEditCalendarService(dependencies); t.after(() => service.close());
  const claims = who => ({ whatsapp: who, sub: who, company_id: who, token_version: 2, iss: "ia4tube-api", aud: "ia4tube-client", jti: crypto.randomUUID() });
  async function context(who = owner, policy = {}) {
    return service.createContext(claims(who), { requestId: crypto.randomUUID(), date: new Date(now + 2 * 86400000).toISOString().slice(0, 10),
      time: "14:00", destination: "reel", caption: "Legenda nativa" }, policy);
  }
  function body(ticket, mediaKind = "image") {
    return { schemaVersion: 1, ticket, editOrderId: admissionOrderId(ticket), requestHash: hash(crypto.randomUUID()), mediaKind,
      title: "Modelo sintetico", caption: "Legenda sintetica", durationSeconds: mediaKind === "image" ? null : 10,
      selection: { modelId: crypto.randomUUID(), modelVersion: 1, sourceDigest: hash("synthetic-canonical-catalog") }, quantity: 1 };
  }
  function bindBody(request) { return { ticket: request.ticket, editOrderId: request.editOrderId, title: request.title,
    caption: request.caption, mediaKind: request.mediaKind, durationSeconds: request.durationSeconds, inputHash: hash(`local-producer:${request.editOrderId}`) }; }
  const status = request => service.admissionStatus(request.editOrderId, { requestHash: request.requestHash, contextHash: hash(request.ticket), mediaKind: request.mediaKind });
  const cancel = request => service.cancelAdmission({ schemaVersion: 1, ticket: request.ticket, editOrderId: request.editOrderId,
    requestHash: request.requestHash, reason: "upload_unavailable" });
  return { root, owner, other, service, dependencies, readClients, writeClients, context, body, bindBody, status, cancel,
    setNow: value => { now = value; }, now: () => now, observations: () => observations, setConnection: value => { connection = value; } };
}
function signature(body, timestamp, route = CANCEL_PATH, key = rpcSecret) {
  return "v1=" + crypto.createHmac("sha256", key).update(`v1\nPOST\n${route}\n${timestamp}\n${hash(canonicalJson(body))}`).digest("hex");
}
async function withoutFilesystemWrites(action) {
  const writes = [], originals = new Map();
  for (const name of ["mkdirSync", "writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync", "truncateSync", "ftruncateSync", "writeSync", "chmodSync", "chownSync", "symlinkSync", "linkSync", "copyFileSync", "utimesSync"]) {
    originals.set(name, fs[name]); fs[name] = function () { writes.push(name); throw new Error("Unexpected filesystem write in capability validation"); };
  }
  originals.set("openSync", fs.openSync); fs.openSync = function (file, flags, ...rest) {
    if (typeof flags !== "string" || /[wax+]/.test(flags)) { writes.push("openSync-write"); throw new Error("Unexpected write-open in capability validation"); }
    return originals.get("openSync").call(fs, file, flags, ...rest);
  };
  try { return await action(); }
  finally { for (const [name, original] of originals) fs[name] = original; assert.deepEqual(writes, [], "Rejected capability must attempt no filesystem mutations"); }
}
function seedPriorRandomAdmissionId(f, request) {
  // Synthetic on-disk fixture for intents emitted by the previous trusted receiver, before deterministic IDs.
  const contextPath = path.join(f.root, "private/edit-calendar/contexts", request.ticket.slice(0, 36) + ".json");
  const row = JSON.parse(fs.readFileSync(contextPath, "utf8")), legacy = { ...request, editOrderId: crypto.randomUUID() };
  const { ticket, ...identity } = legacy;
  row.admission.editOrderId = legacy.editOrderId; row.admission.inputIdentity = hash(canonicalJson(identity));
  atomicWriteJson(contextPath, row);
  const claimRoot = path.join(f.root, "private/edit-calendar/orders");
  fs.renameSync(path.join(claimRoot, request.editOrderId + ".json"), path.join(claimRoot, legacy.editOrderId + ".json"));
  const plan = planning.findPlanningById({ baseDir: f.dependencies.planningDir, whatsapp: f.owner, planningId: row.planningId });
  if (plan) {
    const stored = JSON.parse(fs.readFileSync(plan.solicitacao_path, "utf8")); stored.edit_calendar.editOrderId = legacy.editOrderId;
    atomicWriteJson(plan.solicitacao_path, stored);
  }
  return legacy;
}
function countChildOrderFiles(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => count +
    (entry.isDirectory() ? countChildOrderFiles(path.join(directory, entry.name)) : entry.name === "pedido.json" ? 1 : 0), 0);
}

test("new admission UUID is the exact purpose-separated full-ticket SHA256 vector", () => {
  const ticket = "11111111-1111-4111-8111-111111111111." + "A".repeat(43);
  assert.equal(admissionOrderId(ticket), "0abe965a-0229-4e18-8e15-6672e8cabb9f");
  assert.match(admissionOrderId(ticket), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => admissionOrderId(" " + ticket), { code: "edit_calendar_input_invalid" });
  assert.throws(() => admissionOrderId(ticket + "\n"), { code: "edit_calendar_input_invalid" });
  assert.notEqual(admissionOrderId(ticket), admissionOrderId(ticket.slice(0, -1) + "B"));
});
test("feature off and missing private key keep cancellation disabled", () => {
  for (const options of [{}, { enabled: true }, { enabled: false, secret: rpcSecret }, { enabled: true, secret: "too-short" }])
    assert.throws(() => createAdmissionAuthentication(options).authenticate(CANCEL_PATH, {}, {}), { code: "edit_calendar_admission_disabled", statusCode: 503 });
});
test("private cancellation HMAC accepts reordered JSON keys without changing request identity", () => {
  const now = Date.now(), timestamp = String(Math.floor(now / 1000)), body = { z: [3, { b: 2, a: 1 }], a: "stable" };
  const auth = createAdmissionAuthentication({ enabled: true, secret: rpcSecret, clock: () => now });
  assert.doesNotThrow(() => auth.authenticate(CANCEL_PATH, { "x-ia4tube-edit-timestamp": timestamp,
    "x-ia4tube-edit-signature": signature(body, timestamp) }, { a: "stable", z: [3, { a: 1, b: 2 }] }));
});
for (const variant of ["missing", "wrong-secret", "changed-body", "old", "future", "wrong-path", "malformed"]) test(`private cancellation HMAC rejects ${variant}`, () => {
  const now = Date.now(), timestamp = String(Math.floor(now / 1000) + (variant === "old" ? -301 : variant === "future" ? 301 : 0));
  const body = { a: 1 }, headers = { "x-ia4tube-edit-timestamp": timestamp,
    "x-ia4tube-edit-signature": signature(body, timestamp, CANCEL_PATH, variant === "wrong-secret" ? secret : rpcSecret) };
  if (variant === "missing") delete headers["x-ia4tube-edit-signature"];
  if (variant === "malformed") headers["x-ia4tube-edit-signature"] = "v1=bad";
  assert.throws(() => createAdmissionAuthentication({ enabled: true, secret: rpcSecret, clock: () => now })
    .authenticate(variant === "wrong-path" ? ADMIT_PATH : CANCEL_PATH, headers, variant === "changed-body" ? { a: 2 } : body),
  { code: "edit_calendar_admission_unauthorized" });
});
test("context remains free and a reserved admission creates no child or production input hash", async t => {
  const f = fixture(t), before = f.readClients(), ctx = await f.context(), request = f.body(ctx.ticket);
  assert.deepEqual(f.readClients(), before);
  const result = await f.service.admit(request);
  assert.equal(result.admission.state, "reserved"); assert.equal(result.admission.quantity, 1);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1); assert.equal(f.observations(), 0);
  const plan = planning.findPlanningById({ baseDir: f.dependencies.planningDir, whatsapp: f.owner, planningId: result.admission.planningId });
  assert.equal(plan.edit_calendar.kind, "edit_calendar_admission_v1"); assert.equal(plan.edit_calendar.requestHash, request.requestHash);
  assert.equal(Object.hasOwn(plan.edit_calendar, "inputHash"), false);
  assert.equal(plan.runner_contract.pronto_para_runner, false);
  assert.equal(planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: result.admission.pedidoId }), null);
  assert.throws(() => planning.savePlanResult({ baseDir: f.dependencies.planningDir, planningId: result.admission.planningId,
    pedidosDir: f.dependencies.ordersDir, payload: { postagens: [{}] } }), { code: "edit_calendar_admission_required" });
});
test("concurrent exact admission retries reserve one unit and return one receipt", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.admit(request)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("two requests competing for the last paid unit produce one reservation", async t => {
  const f = fixture(t, { client: { artes_mensais_restantes: 1 } });
  const first = f.body((await f.context()).ticket, "video"), second = f.body((await f.context()).ticket, "video");
  const results = await Promise.allSettled([f.service.admit(first), f.service.admit(second)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(results.find(value => value.status === "rejected").reason.code, "billing_required");
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 0);
});
for (const field of ["requestHash", "mediaKind", "selection", "quantity", "editOrderId"]) test(`admission refuses changed ${field} on replay`, async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket); await f.service.admit(request);
  const changed = { ...request, [field]: field === "requestHash" ? "f".repeat(64) : field === "mediaKind" ? "video" :
    field === "selection" ? { ...request.selection, modelVersion: 2 } : field === "quantity" ? 2 : crypto.randomUUID() };
  if (field === "mediaKind") changed.durationSeconds = 10;
  await assert.rejects(f.service.admit(changed), { code: field === "quantity" ? "edit_calendar_input_invalid" : "edit_calendar_admission_conflict" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
for (const change of [{ quantity: 0 }, { quantity: 2 }, { quantity: 0.5 }, { mediaKind: "image", durationSeconds: 10 },
  { mediaKind: "video", durationSeconds: 2.99 }, { mediaKind: "video", durationSeconds: 60.01 }, { mediaKind: "video", durationSeconds: null }])
  test(`typed admission rejects ${JSON.stringify(change)} before charge`, async t => {
    const f = fixture(t), request = { ...f.body((await f.context()).ticket), ...change }, before = f.readClients();
    await assert.rejects(f.service.admit(request), { code: "edit_calendar_input_invalid" }); assert.deepEqual(f.readClients(), before);
  });
test("producer bind uses its distinct snapshot hash and never debits the admission again", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket), admitted = await f.service.admit(request), input = f.bindBody(request);
  assert.notEqual(input.inputHash, request.requestHash);
  const bound = f.service.bind(input); assert.deepEqual(f.service.bind(input), bound);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1); assert.equal(f.status(request).admission.state, "bound");
  assert.equal((await f.service.admit(request)).admission.state, "bound");
  const child = planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: admitted.admission.pedidoId });
  assert.equal(child.pedido.edit_calendar.inputHash, input.inputHash);
  assert.equal(Object.hasOwn(child.pedido.edit_calendar, "requestHash"), false);
});

test("classic video bind without mediaKind reuses its admitted unit and canonical video marker", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket, "video"), admitted = await f.service.admit(request);
  const input = f.bindBody(request); delete input.mediaKind;
  const result = f.service.bind(input); assert.deepEqual(f.service.bind(input), result);
  assert.equal(result.editOrderId, request.editOrderId); assert.equal(result.planningId, admitted.admission.planningId);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
  const found = planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: result.pedidoId });
  assert.equal(found.pedido.edit_calendar.mediaKind, "video"); assert.equal(found.pedido.edit_calendar.inputHash, input.inputHash);
  assert.equal(countChildOrderFiles(f.dependencies.ordersDir), 1);
  const row = JSON.parse(fs.readFileSync(path.join(f.root, "private/edit-calendar/contexts", request.ticket.slice(0, 36) + ".json"), "utf8"));
  assert.equal(Object.hasOwn(row.binding, "mediaKind"), false); assert.equal(row.binding.inputHash, input.inputHash);
});

test("partial classic video bind resumes its already frozen untyped binding without new debit or child", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-30T04:30:00Z") });
  let interrupted = false;
  const f = fixture(t, { fault: stage => { if (stage === "after_request" && !interrupted) { interrupted = true; throw new Error("bind stopped before child"); } } });
  const context = await f.service.createContext({ whatsapp: f.owner }, { requestId: crypto.randomUUID(),
    date: "2026-10-30", time: "01:38", destination: "reel", caption: "Legenda nativa" });
  const request = f.body(context.ticket, "video"); await f.service.admit(request);
  const input = f.bindBody(request); delete input.mediaKind;
  assert.throws(() => f.service.bind(input), /bind stopped before child/);
  const contextPath = path.join(f.root, "private/edit-calendar/contexts", request.ticket.slice(0, 36) + ".json");
  const stopped = JSON.parse(fs.readFileSync(contextPath, "utf8")), frozen = structuredClone(stopped.binding);
  assert.equal(stopped.phase, "allocating"); assert.equal(stopped.admission.state, "reserved");
  assert.equal(f.status(request).admission.state, "bound"); assert.equal(Object.hasOwn(frozen, "mediaKind"), false);
  assert.equal(countChildOrderFiles(f.dependencies.ordersDir), 0); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
  const plan = planning.findPlanningById({ baseDir: f.dependencies.planningDir, whatsapp: f.owner, planningId: stopped.planningId });
  assert.equal(plan.edit_calendar.kind, "edit_calendar_v1"); assert.equal(plan.edit_calendar.mediaKind, "video");
  assert.equal(plan.edit_calendar.inputHash, input.inputHash);
  f.setNow(f.now() + 10 * 60000); t.mock.timers.tick(10 * 60000);
  assert.ok(Date.now() > Date.parse("2026-10-30T04:38:00Z"), "Resume occurs after the selected Brazilian time");
  const resumed = createEditCalendarService({ ...f.dependencies, fault: () => {} }); t.after(() => resumed.close());
  const result = resumed.bind(input); assert.deepEqual(resumed.bind(input), result);
  assert.equal(result.editOrderId, request.editOrderId); assert.equal(result.planningId, stopped.planningId); assert.equal(result.pedidoId, stopped.pedidoId);
  const completed = JSON.parse(fs.readFileSync(contextPath, "utf8")); assert.deepEqual(completed.binding, frozen); assert.equal(completed.phase, "bound");
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1); assert.equal(countChildOrderFiles(f.dependencies.ordersDir), 1);
  const found = planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: result.pedidoId });
  assert.equal(found.pedido.edit_calendar.inputHash, frozen.inputHash); assert.equal(found.pedido.edit_calendar.mediaKind, "video");
  assert.equal(found.pedido.data_sugerida, "2026-10-30"); assert.equal(found.pedido.horario_sugerido, "01:38");
  const returned = planning.findPlanningById({ baseDir: f.dependencies.planningDir, whatsapp: f.owner, planningId: result.planningId });
  assert.equal(returned.plano_mensal.postagens[0].data_sugerida, "2026-10-30"); assert.equal(returned.plano_mensal.postagens[0].horario_sugerido, "01:38");
});

test("legacy untyped video binding keeps its original marker and retry behavior with admission off", async t => {
  const f = fixture(t, { admissionEnabled: false }), request = f.body((await f.context()).ticket, "video"); request.editOrderId = crypto.randomUUID();
  const input = f.bindBody(request); delete input.mediaKind;
  const result = f.service.bind(input); assert.deepEqual(f.service.bind(input), result);
  const found = planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: result.pedidoId });
  assert.equal(Object.hasOwn(found.pedido.edit_calendar, "mediaKind"), false); assert.equal(found.pedido.edit_calendar.inputHash, input.inputHash);
  const plan = planning.findPlanningById({ baseDir: f.dependencies.planningDir, whatsapp: f.owner, planningId: result.planningId });
  assert.equal(Object.hasOwn(plan.edit_calendar, "mediaKind"), false);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1); assert.equal(countChildOrderFiles(f.dependencies.ordersDir), 1);
});
test("a new production bind without admission is refused when enabled", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket);
  assert.throws(() => f.service.bind(f.bindBody(request)), { code: "edit_calendar_admission_required" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 2);
});
test("a cancelled paid admission refunds once and can never bind or admit again", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket); await f.service.admit(request);
  const cancelled = f.cancel(request); assert.deepEqual(f.cancel(request), cancelled);
  assert.equal(cancelled.admission.state, "cancelled"); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 2);
  assert.throws(() => f.service.bind(f.bindBody(request)), { code: "edit_calendar_admission_conflict" });
  await assert.rejects(f.service.admit(request), { code: "edit_calendar_admission_conflict" });
});
test("cancellation after a production bind is refused without crediting", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket); await f.service.admit(request); f.service.bind(f.bindBody(request));
  assert.throws(() => f.cancel(request), { code: "edit_calendar_admission_not_cancellable" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("standalone credit can be reserved and safely returned before bind", async t => {
  const f = fixture(t, { client: { plano_status: "none", artes_mensais_restantes: 0, artes_avulsas_restantes: 1 } });
  const request = f.body((await f.context()).ticket, "video"); await f.service.admit(request);
  assert.equal(f.readClients()[f.owner].artes_avulsas_restantes, 0); f.cancel(request);
  const client = f.readClients()[f.owner]; assert.equal(client.artes_avulsas_restantes, 1); assert.equal(client.artes_avulsas_usadas, 0);
  assert.deepEqual(client.artes_avulsas_consumos, []);
});
test("new signup policy is opt-in and never resets a consumed legacy benefit", () => {
  const old = process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY;
  try {
    delete process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY;
    const legacy = {}; billing.markFreeArtEligible(legacy); assert.equal(legacy.arte_gratis_disponivel, true);
    process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY = "true";
    const fresh = {}; billing.markFreeArtEligible(fresh); assert.equal(fresh.arte_gratis_disponivel, false);
    const used = { arte_gratis_usada: true, arte_gratis_usos: [{ pedido_id: "historical" }] };
    billing.markFreeArtEligible(used); assert.equal(used.arte_gratis_usada, true); assert.equal(used.arte_gratis_usos.length, 1);
    assert.equal(billing.hasAvailableFreeCompanyArt({ arte_gratis_disponivel: true, arte_gratis_usada: false,
      arte_gratis_usos: [{ pedido_id: "historical" }] }), false, "the common legacy charge guard also honors consumed history under the policy");
  } finally { if (old === undefined) delete process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY; else process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY = old; }
});
const freeClient = { plano_status: "none", artes_mensais_restantes: 0, arte_gratis_disponivel: false, arte_gratis_usada: false, arte_gratis_usos: [] };
test("one confirmed Instagram image consumes the existing common free-art right exactly once", async t => {
  const f = fixture(t, { client: freeClient }), request = f.body((await f.context()).ticket);
  await f.service.admit(request); await f.service.admit(request);
  const client = f.readClients()[f.owner]; assert.equal(client.arte_gratis_usada, true); assert.equal(client.arte_gratis_usos.length, 1);
  assert.equal(billing.hasAvailableFreeCompanyArt(client), false);
  const second = f.body((await f.context()).ticket); await assert.rejects(f.service.admit(second), { code: "billing_required" });
});
for (const change of [{ state: "disconnected" }, { health: "expired" }, { accountType: "personal" }, { externalId: "forged" }])
  test(`a free image refuses unconfirmed Instagram ${JSON.stringify(change)}`, async t => {
    const f = fixture(t, { client: freeClient }); f.setConnection({ provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "123456789012345", ...change });
    await assert.rejects(f.service.admit(f.body((await f.context()).ticket)), { code: "billing_required" });
    assert.equal(f.readClients()[f.owner].arte_gratis_usada, false);
  });
test("free eligibility never pays for a video", async t => {
  const f = fixture(t, { client: { ...freeClient, arte_gratis_disponivel: true } }), request = f.body((await f.context()).ticket, "video");
  await assert.rejects(f.service.admit(request), { code: "billing_required" }); assert.equal(f.observations(), 0);
  assert.equal(f.readClients()[f.owner].arte_gratis_usada, false);
});
for (const history of [{ arte_gratis_usada: true }, { arte_gratis_pedido_id: "legacy-used" }, { arte_gratis_usos: [{ pedido_id: "legacy-used" }] }])
  test(`legacy consumption cannot receive another Instagram free image ${Object.keys(history)[0]}`, async t => {
    const f = fixture(t, { client: { ...freeClient, ...history } });
    await assert.rejects(f.service.admit(f.body((await f.context()).ticket)), { code: "billing_required" }); assert.equal(f.observations(), 0);
  });
test("same Instagram cannot receive the promotion through a second product account", async t => {
  const f = fixture(t, { client: freeClient }); await f.service.admit(f.body((await f.context()).ticket));
  await assert.rejects(f.service.admit(f.body((await f.context(f.other)).ticket)), { code: "billing_required" });
  assert.equal(f.readClients()[f.other].arte_gratis_usada, false);
});
test("legacy migration preserves a consumed owner fingerprint without exposing historical identities", async t => {
  const f = fixture(t, { client: freeClient }), clients = f.readClients();
  clients[f.other].arte_gratis_usada = true; clients[f.other].arte_gratis_pedido_id = "historical-order"; f.writeClients(clients);
  await f.service.admit(f.body((await f.context()).ticket));
  const ledgerText = fs.readFileSync(path.join(f.root, "private/edit-calendar/free-image-ledger.json"), "utf8");
  assert.equal(ledgerText.includes(f.owner), false); assert.equal(ledgerText.includes(f.other), false);
  assert.equal(ledgerText.includes("123456789012345"), false); assert.equal(ledgerText.includes("historical-order"), false);
  const rewritten = f.readClients(); rewritten[f.other] = { ...rewritten[f.other], ...freeClient }; delete rewritten[f.other].arte_gratis_pedido_id; f.writeClients(rewritten);
  f.setConnection({ provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "99999999999999" });
  await assert.rejects(f.service.admit(f.body((await f.context(f.other)).ticket)), { code: "billing_required" });
});
test("disconnect reconnect or changing Instagram does not refresh a consumed free image", async t => {
  const f = fixture(t, { client: freeClient }); await f.service.admit(f.body((await f.context()).ticket));
  f.setConnection({ provider: "instagram", state: "connected", health: "healthy", accountType: "creator", externalId: "98765432100000" });
  await assert.rejects(f.service.admit(f.body((await f.context()).ticket)), { code: "billing_required" });
});
test("a pre-production cancelled new gift restores only that right without emitting a generic gift", async t => {
  const f = fixture(t, { client: freeClient }), request = f.body((await f.context()).ticket); await f.service.admit(request); f.cancel(request);
  const client = f.readClients()[f.owner]; assert.equal(client.arte_gratis_disponivel, false); assert.equal(client.arte_gratis_usada, false);
  assert.deepEqual(client.arte_gratis_usos, []);
  await f.service.admit(f.body((await f.context()).ticket)); assert.equal(f.readClients()[f.owner].arte_gratis_usos.length, 1);
});
test("grandfathered unused free right is one shared right and is preserved on cancellation", async t => {
  const f = fixture(t, { client: { ...freeClient, arte_gratis_disponivel: true } }), request = f.body((await f.context()).ticket);
  await f.service.admit(request); assert.equal(billing.hasAvailableFreeCompanyArt(f.readClients()[f.owner]), false);
  f.cancel(request); assert.equal(billing.hasAvailableFreeCompanyArt(f.readClients()[f.owner]), true);
});
for (const stage of ["admission_after_journal", "admission_after_request", "admission_after_client_commit"]) test(`admission crash recovery ${stage} keeps one debit`, async t => {
  let injected = false;
  const f = fixture(t, { fault: current => { if (current === stage && !injected) { injected = true; throw new Error("synthetic interruption"); } } });
  const request = f.body((await f.context()).ticket); await assert.rejects(f.service.admit(request), /synthetic interruption/);
  const fresh = createEditCalendarService({ ...f.dependencies, fault: () => {} }); t.after(() => fresh.close());
  const result = await fresh.admit(request); assert.deepEqual(await fresh.admit(request), result);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
for (const stage of ["admission_cancel_after_journal", "admission_cancel_after_client_commit"]) test(`refund crash recovery ${stage} credits once`, async t => {
  let injected = false;
  const f = fixture(t, { fault: current => { if (current === stage && !injected) { injected = true; throw new Error("synthetic interruption"); } } });
  const request = f.body((await f.context()).ticket); await f.service.admit(request); assert.throws(() => f.cancel(request), /synthetic interruption/);
  const fresh = createEditCalendarService({ ...f.dependencies, fault: () => {} }); t.after(() => fresh.close());
  const payload = { schemaVersion: 1, ticket: request.ticket, editOrderId: request.editOrderId, requestHash: request.requestHash, reason: "upload_unavailable" };
  const result = fresh.cancelAdmission(payload); assert.deepEqual(fresh.cancelAdmission(payload), result);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 2);
});
test("an expired unallocated ticket cannot admit, while an issued reserve survives expiry without new charge", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket), pending = f.body((await f.context()).ticket);
  const result = await f.service.admit(request); f.setNow(f.now() + 8 * 86400000);
  await assert.rejects(f.service.admit(pending), { code: "edit_calendar_context_expired" });
  assert.deepEqual(await f.service.admit(request), result); f.service.bind(f.bindBody(request));
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("credit replenishment retries the same refused admission without duplicate reservation", async t => {
  const f = fixture(t, { client: { artes_mensais_restantes: 0 } }), request = f.body((await f.context()).ticket, "video");
  await assert.rejects(f.service.admit(request), { code: "billing_required" });
  const clients = f.readClients(); clients[f.owner].artes_mensais_restantes = 1; f.writeClients(clients);
  await f.service.admit(request); await f.service.admit(request); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 0);
});
test("an unfunded admission journal does not bypass the context TTL after replenishment", async t => {
  const f = fixture(t, { client: { artes_mensais_restantes: 0 } }), request = f.body((await f.context()).ticket, "video");
  await assert.rejects(f.service.admit(request), { code: "billing_required" }); f.setNow(f.now() + 8 * 86400000);
  const clients = f.readClients(); clients[f.owner].artes_mensais_restantes = 2; f.writeClients(clients);
  await assert.rejects(f.service.admit(request), { code: "edit_calendar_context_expired" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 2);
  assert.equal(Object.keys(f.readClients()[f.owner].planejamento_mensal_reservas || {}).length, 0);
});
test("status is observational, owner-scoped and refuses identity substitutions", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket); const result = await f.service.admit(request);
  const before = f.readClients(), file = path.join(f.root, "private/edit-calendar/contexts", request.ticket.slice(0, 36) + ".json"), bytes = fs.readFileSync(file);
  assert.deepEqual(f.status(request), result); assert.deepEqual(f.status(request), result);
  assert.deepEqual(f.readClients(), before); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => f.service.admissionStatus(request.editOrderId, { requestHash: request.requestHash, contextHash: "f".repeat(64), mediaKind: "image" }), { code: "edit_calendar_admission_conflict" });
});
test("a legacy planning cancellation cannot be offered as a reserved admission or successful ACK replay", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket, "video"), admitted = await f.service.admit(request);
  const clients = f.readClients(); planning.cancelPlanning({ baseDir: f.dependencies.planningDir, whatsapp: f.owner,
    planningId: admitted.admission.planningId, cliente: clients[f.owner] }); f.writeClients(clients);
  assert.throws(() => f.status(request), { code: "edit_calendar_admission_conflict" });
  await assert.rejects(f.service.admit(request), { code: "edit_calendar_admission_conflict" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 2);
});
test("flag off retains existing unpaid browsing and legacy operator binding behavior", async t => {
  const f = fixture(t, { admissionEnabled: false }), request = f.body((await f.context()).ticket);
  request.editOrderId = crypto.randomUUID();
  await assert.rejects(f.service.admit(request), { code: "edit_calendar_admission_disabled" });
  const bound = f.service.bind(f.bindBody(request)); assert.deepEqual(f.service.bind(f.bindBody(request)), bound);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("enabling admission preserves an already emitted legacy bound intent without another charge", async t => {
  const f = fixture(t, { admissionEnabled: false }), request = f.body((await f.context()).ticket);
  request.editOrderId = crypto.randomUUID(); f.service.bind(f.bindBody(request));
  const fresh = createEditCalendarService({ ...f.dependencies, admissionEnabled: true }); t.after(() => fresh.close());
  assert.equal((await fresh.admit(request)).admission.state, "bound"); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("enabling admission preserves a legacy allocation already issued before the feature", async t => {
  let failed = false;
  const f = fixture(t, { admissionEnabled: false, fault: stage => { if (stage === "after_request" && !failed) { failed = true; throw new Error("legacy interruption"); } } });
  const request = f.body((await f.context()).ticket); request.editOrderId = crypto.randomUUID(); const input = f.bindBody(request);
  assert.throws(() => f.service.bind(input), /legacy interruption/);
  const fresh = createEditCalendarService({ ...f.dependencies, admissionEnabled: true, fault: () => {} }); t.after(() => fresh.close());
  const bound = fresh.bind(input); assert.deepEqual(fresh.bind(input), bound); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("a pending legacy context remains manually bindable after enabling admission", async t => {
  const f = fixture(t, { admissionEnabled: false }), request = f.body((await f.context()).ticket, "video");
  request.editOrderId = crypto.randomUUID();
  const fresh = createEditCalendarService({ ...f.dependencies, admissionEnabled: true }); t.after(() => fresh.close());
  const bound = fresh.bind(f.bindBody(request)); assert.deepEqual(fresh.bind(f.bindBody(request)), bound);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("a reserved admission binds after rollover without touching the new monthly cycle", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket, "video"); await f.service.admit(request); f.service.close();
  const clients = f.readClients(), client = clients[f.owner];
  client.plano_ciclo = "2098-11"; client.artes_mensais_total = 20; client.artes_mensais_restantes = 20;
  client.planejamento_mensal_ciclo = "2098-11"; client.planejamento_mensal_reservas = {};
  client.planejamento_mensal_artes_reservadas = 0; client.planejamento_mensal_ja_produzidas = 0; f.writeClients(clients);
  const before = f.readClients();
  const fresh = createEditCalendarService(f.dependencies); t.after(() => fresh.close());
  const bound = fresh.bind(f.bindBody(request)); assert.deepEqual(fresh.bind(f.bindBody(request)), bound);
  assert.deepEqual(f.readClients(), before); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 20);
  assert.ok(planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: bound.pedidoId }));
});
test("cancelling an old-cycle reserve never credits the new cycle without reconciliation", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket, "video"); await f.service.admit(request);
  const clients = f.readClients(); clients[f.owner].plano_ciclo = "2098-11"; clients[f.owner].artes_mensais_restantes = 20;
  clients[f.owner].planejamento_mensal_ciclo = "2098-11"; clients[f.owner].planejamento_mensal_reservas = {}; f.writeClients(clients);
  const before = f.readClients(); assert.throws(() => f.cancel(request), { code: "edit_calendar_allocation_reconciliation_required" });
  assert.deepEqual(f.readClients(), before); assert.equal(f.status(request).admission.state, "reserved");
});
test("cancelled gift can retry on its own IP receipt without clearing the network lock for another owner", async t => {
  const ipHash = "b".repeat(64), identity = { ipHash, ipMasked: "192.0.2.0" }; let ipFile;
  const readIp = () => fs.existsSync(ipFile) ? JSON.parse(fs.readFileSync(ipFile, "utf8")) : {};
  const f = fixture(t, { client: freeClient,
    currentFreeArtBlocked: ip => Boolean(ip?.ipHash && readIp()[ip.ipHash]),
    recordFreeArtUse: ({ owner, planningId, ipIdentity }) => {
      const locks = readIp(); locks[ipIdentity.ipHash] = { cliente: owner, pedido_id: planningId, bloqueado_ate: "2099-01-01" };
      atomicWriteJson(ipFile, locks); return true;
    },
    canReuseCancelledFreeArt: ({ owner, planningId, ipIdentity }) => {
      const receipt = readIp()[ipIdentity.ipHash]; return receipt?.cliente === owner && receipt?.pedido_id === planningId;
    } });
  ipFile = path.join(f.root, "synthetic-ip-locks.json");
  const first = f.body((await f.context(f.owner, { ipIdentity: identity })).ticket); await f.service.admit(first); f.cancel(first);
  assert.equal(readIp()[ipHash].cliente, f.owner);
  const retry = f.body((await f.context(f.owner, { freeArtBlocked: true, ipIdentity: identity })).ticket);
  await f.service.admit(retry); assert.equal(f.readClients()[f.owner].arte_gratis_usos.length, 1);
  f.setConnection({ provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "99887766554433" });
  const other = f.body((await f.context(f.other, { freeArtBlocked: true, ipIdentity: identity })).ticket);
  await assert.rejects(f.service.admit(other), { code: "billing_required" }); assert.equal(f.readClients()[f.other].arte_gratis_usada, false);
});
test("a real terminated admission process recovers its dead lock and persisted reservation", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket, "video");
  const modulePath = require.resolve("../src/company-edit-calendar/service"), writer = require.resolve("../src/notifications/fcm-token-store");
  const script = `const fs=require('node:fs');const{createEditCalendarService}=require(${JSON.stringify(modulePath)});const{atomicWriteJson}=require(${JSON.stringify(writer)});const file=${JSON.stringify(path.join(f.root, "clients.json"))};createEditCalendarService({dataDir:${JSON.stringify(f.root)},planningDir:${JSON.stringify(f.dependencies.planningDir)},ordersDir:${JSON.stringify(f.dependencies.ordersDir)},secret:${JSON.stringify(secret)},readClients:()=>JSON.parse(fs.readFileSync(file,'utf8')),writeClients:v=>atomicWriteJson(file,v),prepareCalendarRequest:async()=>null,admissionEnabled:true,fault:s=>{if(s==='admission_after_client_commit')process.exit(41)}}).admit(${JSON.stringify(request)}).catch(()=>process.exit(42));`;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 41, child.stderr); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
  const recovered = await f.service.admit(request); assert.deepEqual(await f.service.admit(request), recovered);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
for (const stage of ["admission_after_request", "admission_after_client_commit"]) test(`free-image journal recovers ${stage} without another right`, async t => {
  let failed = false;
  const f = fixture(t, { client: freeClient, fault: current => { if (current === stage && !failed) { failed = true; throw new Error("gift interruption"); } } });
  const request = f.body((await f.context()).ticket); await assert.rejects(f.service.admit(request), /gift interruption/);
  const fresh = createEditCalendarService({ ...f.dependencies, fault: () => {} }); t.after(() => fresh.close());
  await fresh.admit(request); await fresh.admit(request); assert.equal(f.readClients()[f.owner].arte_gratis_usos.length, 1);
});
test("a forged capability or inactive owner never reserves any paid or free balance", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket), before = f.readClients();
  await assert.rejects(f.service.admit({ ...request, ticket: request.ticket.slice(0, 37) + "x".repeat(43) }), { code: "edit_calendar_context_unavailable" });
  assert.deepEqual(f.readClients(), before);
  const clients = f.readClients(); clients[f.owner].ativo = false; f.writeClients(clients);
  await assert.rejects(f.service.admit(request), { code: "edit_calendar_session_required" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 2);
});
test("one external order ID cannot claim a second context or owner", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket); await f.service.admit(request);
  const other = { ...f.body((await f.context(f.other)).ticket), editOrderId: request.editOrderId };
  await assert.rejects(f.service.admit(other), { code: "edit_calendar_order_conflict" });
  assert.equal(f.readClients()[f.other].artes_mensais_restantes, 2);
});
test("IP policy remains a refusal for a new free image without blocking paid credits", async t => {
  const f = fixture(t, { client: freeClient, currentFreeArtBlocked: () => true });
  await assert.rejects(f.service.admit(f.body((await f.context()).ticket)), { code: "billing_required" });
  const clients = f.readClients(); clients[f.owner].artes_avulsas_restantes = 1; f.writeClients(clients);
  await f.service.admit(f.body((await f.context()).ticket));
  assert.equal(f.readClients()[f.owner].artes_avulsas_restantes, 0); assert.equal(f.readClients()[f.owner].arte_gratis_usada, false);
});
test("an unavailable Instagram observation fails closed for a gift and does not run a provider", async t => {
  const f = fixture(t, { client: freeClient, observeConnection: async () => { throw new Error("synthetic DB unavailable"); } });
  await assert.rejects(f.service.admit(f.body((await f.context()).ticket)), { code: "edit_calendar_admission_unavailable" });
  assert.equal(f.readClients()[f.owner].arte_gratis_usada, false);
});
test("a producer cannot change an admitted image into a free video", async t => {
  const f = fixture(t, { client: freeClient }), request = f.body((await f.context()).ticket); await f.service.admit(request);
  assert.throws(() => f.service.bind({ ...f.bindBody(request), mediaKind: "video", durationSeconds: 10 }), { code: "edit_calendar_admission_conflict" });
  assert.equal(f.status(request).admission.state, "reserved");
});
test("status fences a producer claim after a crash instead of offering it for automatic approval again", async t => {
  const f = fixture(t, { fault: stage => { if (stage === "after_request") throw new Error("producer claim interruption"); } });
  const request = f.body((await f.context()).ticket); await f.service.admit(request);
  assert.throws(() => f.service.bind(f.bindBody(request)), /producer claim interruption/);
  assert.equal(f.status(request).admission.state, "bound");
  assert.throws(() => f.cancel(request), { code: "edit_calendar_admission_not_cancellable" });
});
test("HTTP admission uses only its ticket capability; private bot scope and cancellation stay separate", async t => {
  const f = fixture(t), auth = createAdmissionAuthentication({ enabled: true, clock: f.now });
  const app = express(); app.use((req, res, next) => isAdmissionRequest(req) ? admissionJsonParser(req, res, next) : express.json()(req, res, next));
  app.use(admissionJsonError);
  const botAuthenticate = (req, res, next) => { if (req.headers.authorization !== "synthetic-bot") return res.sendStatus(401); req.user = { admin: true }; next(); };
  app.use(createEditCalendarRouter({ authenticate: (_req, res) => res.sendStatus(401), botAuthenticate,
    isBotAdmin: req => req.user.admin, service: f.service, admissionAuthenticate: auth.authenticate }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, request = f.body((await f.context()).ticket);
  const send = (headers = {}, body = request) => fetch(origin + ADMIT_PATH, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await send({ authorization: "synthetic-bot" }, { ...request, ticket: `${crypto.randomUUID()}.${"x".repeat(43)}` })).status, 404);
  const accepted = await send();
  assert.equal(accepted.status, 200); assert.equal(accepted.headers.get("cache-control"), "no-store");
  const query = new URLSearchParams({ requestHash: request.requestHash, contextHash: hash(request.ticket), mediaKind: request.mediaKind });
  const lookup = origin + `/bot/empresa/edit/orders/${request.editOrderId}/admission?${query}`;
  assert.equal((await fetch(lookup)).status, 401); assert.equal((await fetch(lookup, { headers: { authorization: "synthetic-bot" } })).status, 200);
  const cancelled = await fetch(origin + CANCEL_PATH, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, ticket: request.ticket, editOrderId: request.editOrderId, requestHash: request.requestHash, reason: "submission_aborted" }) });
  assert.equal(cancelled.status, 503); assert.equal(f.status(request).admission.state, "reserved");
});

for (const variant of ["unknown", "bad-mac", "inactive-owner", "expired", "extra-owner", "quantity-two", "long-title", "long-caption", "disabled",
  "ticket-array", "order-id-array", "request-hash-array", "model-id-array", "source-digest-array"]) test(`public capability ${variant} is rejected before any filesystem mutation`, async t => {
  const f = fixture(t, { admissionEnabled: variant !== "disabled" }), request = f.body((await f.context()).ticket);
  const before = f.readClients();
  if (variant === "unknown") request.ticket = `${crypto.randomUUID()}.${"x".repeat(43)}`;
  if (variant === "bad-mac") request.ticket = `${request.ticket.split(".")[0]}.${"x".repeat(43)}`;
  if (variant === "inactive-owner") { before[f.owner].ativo = false; f.writeClients(before); }
  if (variant === "expired") f.setNow(f.now() + 8 * 86400000);
  if (variant === "extra-owner") request.owner = f.other;
  if (variant === "quantity-two") request.quantity = 2;
  if (variant === "long-title") request.title = "x".repeat(201);
  if (variant === "long-caption") request.caption = "x".repeat(2201);
  if (variant === "ticket-array") request.ticket = [request.ticket];
  if (variant === "order-id-array") request.editOrderId = [request.editOrderId];
  if (variant === "request-hash-array") request.requestHash = [request.requestHash];
  if (variant === "model-id-array") request.selection.modelId = [request.selection.modelId];
  if (variant === "source-digest-array") request.selection.sourceDigest = [request.selection.sourceDigest];
  const code = ["unknown", "bad-mac"].includes(variant) ? "edit_calendar_context_unavailable" : variant === "inactive-owner" ? "edit_calendar_session_required" :
    variant === "expired" ? "edit_calendar_context_expired" : variant === "disabled" ? "edit_calendar_admission_disabled" : "edit_calendar_input_invalid";
  await assert.rejects(withoutFilesystemWrites(() => f.service.admit(request)), { code });
  assert.deepEqual(f.readClients(), before);
});

test("combining another owner's context ID with one's own MAC cannot spend the other owner's quota", async t => {
  const f = fixture(t), own = await f.context(), other = await f.context(f.other), request = f.body(own.ticket);
  request.ticket = `${other.ticket.split(".")[0]}.${own.ticket.split(".")[1]}`;
  const before = f.readClients();
  await assert.rejects(withoutFilesystemWrites(() => f.service.admit(request)), { code: "edit_calendar_context_unavailable" });
  assert.deepEqual(f.readClients(), before);
});

for (const variant of ["another-owner", "known-legacy-unclaimed", "no-balance-known-legacy"]) test(`new capability cannot preempt ${variant} UUID or write its claim`, async t => {
  const f = fixture(t, { client: variant === "no-balance-known-legacy" ? { artes_mensais_restantes: 0 } : {} });
  const request = f.body((await f.context()).ticket, "video");
  request.editOrderId = variant === "another-owner" ? admissionOrderId((await f.context(f.other)).ticket) : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const before = f.readClients(), claimPath = path.join(f.root, "private/edit-calendar/orders", request.editOrderId + ".json");
  assert.equal(fs.existsSync(claimPath), false);
  await assert.rejects(withoutFilesystemWrites(() => f.service.admit(request)), { code: "edit_calendar_order_conflict", statusCode: 409 });
  assert.equal(fs.existsSync(claimPath), false); assert.deepEqual(f.readClients(), before);
});

test("a previously reserved random-ID admission replays after TTL and binds without a second debit", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket, "video"); await f.service.admit(request);
  const legacy = seedPriorRandomAdmissionId(f, request), before = f.readClients(); f.setNow(f.now() + 8 * 86400000);
  const replay = await f.service.admit(legacy); assert.equal(replay.admission.editOrderId, legacy.editOrderId);
  assert.deepEqual(f.readClients(), before);
  const bound = f.service.bind(f.bindBody(legacy)); assert.deepEqual(f.service.bind(f.bindBody(legacy)), bound);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});

test("a previously emitted random-ID allocating journal is recovered with its original identity", async t => {
  let failed = false;
  const f = fixture(t, { fault: stage => { if (stage === "admission_after_journal" && !failed) { failed = true; throw new Error("legacy journal"); } } });
  const request = f.body((await f.context()).ticket, "video"); await assert.rejects(f.service.admit(request), /legacy journal/);
  const legacy = seedPriorRandomAdmissionId(f, request), result = await f.service.admit(legacy);
  assert.equal(result.admission.editOrderId, legacy.editOrderId); assert.equal(result.admission.state, "reserved");
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});

test("a refused pre-existing random-ID admission remains the same intent when funded inside TTL", async t => {
  const f = fixture(t, { client: { artes_mensais_restantes: 0 } }), request = f.body((await f.context()).ticket, "video");
  await assert.rejects(f.service.admit(request), { code: "billing_required" }); const legacy = seedPriorRandomAdmissionId(f, request);
  const clients = f.readClients(); clients[f.owner].artes_mensais_restantes = 1; f.writeClients(clients);
  const result = await f.service.admit(legacy); assert.equal(result.admission.editOrderId, legacy.editOrderId);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 0);
});

test("capability expiry during observational Instagram read is rechecked before filesystem mutations", async t => {
  let f;
  f = fixture(t, { client: { artes_mensais_restantes: 0, arte_gratis_usada: false, arte_gratis_disponivel: false },
    observeConnection: async () => { f.setNow(f.now() + 8 * 86400000); return null; } });
  const request = f.body((await f.context()).ticket), before = f.readClients();
  await assert.rejects(withoutFilesystemWrites(() => f.service.admit(request)), { code: "edit_calendar_context_expired" });
  assert.deepEqual(f.readClients(), before);
});

test("an owner deactivated during the Instagram observation cannot write an admission journal or ledger", async t => {
  let f, active = true;
  f = fixture(t, { client: { artes_mensais_restantes: 0, arte_gratis_usada: false, arte_gratis_disponivel: false },
    readClients: () => { const clients = f.readClients(); clients[f.owner].ativo = active; return clients; },
    observeConnection: async () => { active = false; return null; } });
  const request = f.body((await f.context()).ticket), before = f.readClients();
  await assert.rejects(withoutFilesystemWrites(() => f.service.admit(request)), { code: "edit_calendar_session_required" });
  assert.deepEqual(f.readClients(), before);
});

test("invalid IP attempts never exhaust a valid ticket or another ticket behind shared egress", () => {
  let now = 0;
  const guard = createCapabilityRateGuard({ capacity: 2, clock: () => now, verifyCapability: body => {
    if (!body.valid) throw Object.assign(new Error("invalid"), { statusCode: 404, code: "edit_calendar_context_not_found" });
    return hash(body.ticket);
  } });
  const req = body => ({ body, ip: "synthetic-shared-egress" });
  for (let index = 0; index < 2; index++) assert.throws(() => guard.authorize(req({})), { statusCode: 404 });
  assert.throws(() => guard.authorize(req({})), { statusCode: 429, retryAfter: 30 });
  for (let index = 0; index < 2; index++) assert.doesNotThrow(() => guard.authorize(req({ valid: true, ticket: "first-owner-capability" })));
  assert.throws(() => guard.authorize(req({ valid: true, ticket: "first-owner-capability" })), { statusCode: 429 });
  assert.doesNotThrow(() => guard.authorize(req({ valid: true, ticket: "another-owner-capability" })));
  now = 30000; assert.doesNotThrow(() => guard.authorize(req({ valid: true, ticket: "first-owner-capability" })));
});

test("capability rate maps have bounded cardinality and expire stale keys", () => {
  let now = 0;
  const guard = createCapabilityRateGuard({ maximumKeys: 2, ttlMs: 1000, clock: () => now, verifyCapability: body => {
    if (!body.valid) throw Object.assign(new Error("invalid"), { statusCode: 404 });
    return hash(body.ticket);
  } });
  for (let index = 0; index < 5; index++) {
    guard.authorize({ body: { valid: true, ticket: String(index) }, ip: String(index) });
    assert.throws(() => guard.authorize({ body: {}, ip: String(index) }), { statusCode: 404 });
  }
  assert.deepEqual(guard.sizes(), { invalidIps: 2, tickets: 2 });
  now = 1001; guard.authorize({ body: { valid: true, ticket: "fresh" }, ip: "fresh" });
  assert.throws(() => guard.authorize({ body: {}, ip: "fresh" }), { statusCode: 404 });
  assert.deepEqual(guard.sizes(), { invalidIps: 1, tickets: 1 });
});

test("HTTP public admission bounds JSON at 16KB, sanitizes rate errors and never grants private routes", async t => {
  const f = fixture(t), request = f.body((await f.context()).ticket);
  const guard = createCapabilityRateGuard({ capacity: 2, clock: f.now, verifyCapability: body => f.service.verifyAdmissionCapability(body) });
  const app = express(); app.use((req, res, next) => isAdmissionRequest(req) ? admissionJsonParser(req, res, next) : express.json()(req, res, next));
  app.use(admissionJsonError);
  app.use(createEditCalendarRouter({ service: f.service, authenticate: (_req, res) => res.sendStatus(401),
    botAuthenticate: (_req, res) => res.sendStatus(401), isBotAdmin: () => false, capabilityRateGuard: guard }));
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (body, headers = { "content-type": "application/json" }, route = ADMIT_PATH) => fetch(origin + route, { method: "POST", headers, body });
  const before = f.readClients();
  await withoutFilesystemWrites(async () => {
    const oversized = await send(JSON.stringify(request) + " ".repeat(16384)); assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { ok: false, code: "edit_calendar_input_invalid" });
    assert.equal((await send(JSON.stringify(request) + " ".repeat(16384), undefined, ADMIT_PATH.toUpperCase() + "/")).status, 413);
    assert.equal((await send("{" )).status, 400);
    assert.equal((await send(JSON.stringify(request), { "content-type": "application/x-www-form-urlencoded" })).status, 415);
    for (const headers of [{ "content-type": "application/json; charset=iso-8859-1" },
      { "content-type": "application/json", "content-encoding": "unsupported" }]) {
      const unsupported = await send(JSON.stringify(request), headers); assert.equal(unsupported.status, 415);
      assert.deepEqual(await unsupported.json(), { ok: false, code: "edit_calendar_input_invalid" });
    }
    const preemption = await send(JSON.stringify({ ...request, editOrderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    assert.equal(preemption.status, 409); assert.deepEqual(await preemption.json(), { ok: false, code: "edit_calendar_order_conflict" });
  });
  assert.deepEqual(f.readClients(), before);
  for (let index = 0; index < 2; index++) assert.equal((await send(JSON.stringify(request))).status, 200);
  const limited = await send(JSON.stringify(request)); assert.equal(limited.status, 429); assert.equal(limited.headers.get("Retry-After"), "30");
  assert.deepEqual(await limited.json(), { ok: false, code: "edit_calendar_admission_rate_limited" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
  assert.equal((await send(JSON.stringify(f.bindBody(request)), undefined, "/bot/empresa/edit/orders/bind")).status, 401);
  assert.equal((await send(JSON.stringify({ schemaVersion: 1, ticket: request.ticket, editOrderId: request.editOrderId,
    requestHash: request.requestHash, reason: "upload_unavailable" }), undefined, CANCEL_PATH)).status, 503);
  const receipt = f.status(request).admission; assert.equal(receipt.state, "reserved");
  const plan = planning.findPlanningById({ baseDir: f.dependencies.planningDir, whatsapp: f.owner, planningId: receipt.planningId });
  assert.equal(plan.runner_contract.pronto_para_runner, false);
  assert.equal(planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: receipt.pedidoId }), null);
});
