"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"),
  os = require("node:os"), crypto = require("node:crypto");
const express = require("express");
const { spawnSync } = require("node:child_process");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { createEditCalendarRouter } = require("../src/company-edit-calendar/router");
const { createAdmissionAuthentication, canonicalJson, hash, ADMIT_PATH, CANCEL_PATH } = require("../src/company-edit-calendar/admission-contract");
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
    return { schemaVersion: 1, ticket, editOrderId: crypto.randomUUID(), requestHash: hash(crypto.randomUUID()), mediaKind,
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
function signature(body, timestamp, route = ADMIT_PATH, key = rpcSecret) {
  return "v1=" + crypto.createHmac("sha256", key).update(`v1\nPOST\n${route}\n${timestamp}\n${hash(canonicalJson(body))}`).digest("hex");
}
test("feature off and missing secret refuse admission authentication before any capability is used", () => {
  for (const options of [{}, { enabled: true }, { enabled: false, secret: rpcSecret }, { enabled: true, secret: "too-short" }])
    assert.throws(() => createAdmissionAuthentication(options).authenticate(ADMIT_PATH, {}, {}), { code: "edit_calendar_admission_disabled", statusCode: 503 });
});
test("dedicated HMAC accepts reordered JSON keys without changing the receiver request digest", () => {
  const now = Date.now(), timestamp = String(Math.floor(now / 1000)), body = { z: [3, { b: 2, a: 1 }], a: "stable" };
  const auth = createAdmissionAuthentication({ enabled: true, secret: rpcSecret, clock: () => now });
  assert.doesNotThrow(() => auth.authenticate(ADMIT_PATH, { "x-ia4tube-edit-timestamp": timestamp,
    "x-ia4tube-edit-signature": signature(body, timestamp) }, { a: "stable", z: [3, { a: 1, b: 2 }] }));
});
for (const variant of ["missing", "wrong-secret", "changed-body", "old", "future", "wrong-path", "malformed"]) test(`HMAC rejects ${variant}`, () => {
  const now = Date.now(), timestamp = String(Math.floor(now / 1000) + (variant === "old" ? -301 : variant === "future" ? 301 : 0));
  const body = { a: 1 }, headers = { "x-ia4tube-edit-timestamp": timestamp,
    "x-ia4tube-edit-signature": signature(body, timestamp, ADMIT_PATH, variant === "wrong-secret" ? secret : rpcSecret) };
  if (variant === "missing") delete headers["x-ia4tube-edit-signature"];
  if (variant === "malformed") headers["x-ia4tube-edit-signature"] = "v1=bad";
  assert.throws(() => createAdmissionAuthentication({ enabled: true, secret: rpcSecret, clock: () => now })
    .authenticate(variant === "wrong-path" ? CANCEL_PATH : ADMIT_PATH, headers, variant === "changed-body" ? { a: 2 } : body),
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
  await assert.rejects(f.service.admit(request), { code: "edit_calendar_admission_disabled" });
  const bound = f.service.bind(f.bindBody(request)); assert.deepEqual(f.service.bind(f.bindBody(request)), bound);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("enabling admission preserves an already emitted legacy bound intent without another charge", async t => {
  const f = fixture(t, { admissionEnabled: false }), request = f.body((await f.context()).ticket); f.service.bind(f.bindBody(request));
  const fresh = createEditCalendarService({ ...f.dependencies, admissionEnabled: true }); t.after(() => fresh.close());
  assert.equal((await fresh.admit(request)).admission.state, "bound"); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("enabling admission preserves a legacy allocation already issued before the feature", async t => {
  let failed = false;
  const f = fixture(t, { admissionEnabled: false, fault: stage => { if (stage === "after_request" && !failed) { failed = true; throw new Error("legacy interruption"); } } });
  const request = f.body((await f.context()).ticket), input = f.bindBody(request);
  assert.throws(() => f.service.bind(input), /legacy interruption/);
  const fresh = createEditCalendarService({ ...f.dependencies, admissionEnabled: true, fault: () => {} }); t.after(() => fresh.close());
  const bound = fresh.bind(input); assert.deepEqual(fresh.bind(input), bound); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("a pending legacy context remains manually bindable after enabling admission", async t => {
  const f = fixture(t, { admissionEnabled: false }), request = f.body((await f.context()).ticket, "video");
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
test("HTTP admission uses the dedicated scope; bot read access cannot create an admission", async t => {
  const f = fixture(t), auth = createAdmissionAuthentication({ enabled: true, secret: rpcSecret, clock: f.now });
  const app = express(); app.use(express.json());
  const botAuthenticate = (req, res, next) => { if (req.headers.authorization !== "synthetic-bot") return res.sendStatus(401); req.user = { admin: true }; next(); };
  app.use(createEditCalendarRouter({ authenticate: (_req, res) => res.sendStatus(401), botAuthenticate,
    isBotAdmin: req => req.user.admin, service: f.service, admissionAuthenticate: auth.authenticate }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, request = f.body((await f.context()).ticket), timestamp = String(Math.floor(f.now() / 1000));
  const send = headers => fetch(origin + ADMIT_PATH, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(request) });
  assert.equal((await send({ authorization: "synthetic-bot" })).status, 403);
  const accepted = await send({ "x-ia4tube-edit-timestamp": timestamp, "x-ia4tube-edit-signature": signature(request, timestamp) });
  assert.equal(accepted.status, 200); assert.equal(accepted.headers.get("cache-control"), "no-store");
  const query = new URLSearchParams({ requestHash: request.requestHash, contextHash: hash(request.ticket), mediaKind: request.mediaKind });
  const lookup = origin + `/bot/empresa/edit/orders/${request.editOrderId}/admission?${query}`;
  assert.equal((await fetch(lookup)).status, 401); assert.equal((await fetch(lookup, { headers: { authorization: "synthetic-bot" } })).status, 200);
});
