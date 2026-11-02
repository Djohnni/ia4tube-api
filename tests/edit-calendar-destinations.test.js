"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), express = require("express");
const { createEditCalendarService, contextInput } = require("../src/company-edit-calendar/service");
const { createEditCalendarRouter } = require("../src/company-edit-calendar/router");
const { admissionOrderId, hash } = require("../src/company-edit-calendar/admission-contract");
const { atomicWriteJson } = require("../src/notifications/fcm-token-store");
const planning = require("../src/company-monthly-planning/planning.service");
const billing = require("../src/billing/billing.service"), plans = require("../src/billing/plans");
const { createCalendarSource } = require("../src/social/calendar/source");
const healthy = { provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "123456789012345" };
const secret = "synthetic-edit-destinations-not-a-real-secret";

function fixture(t, options = {}) {
  const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, "ia4tube-destination-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), temp); assert.ok(path.basename(resolved).startsWith("ia4tube-destination-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const owner = "synthetic-destination-owner", clientsPath = path.join(root, "clients.json");
  const client = { ativo: true, nome_empresa: "Loja sintética", ramo: "Loja", arte_gratis_usada: true, artes_avulsas_restantes: 0 };
  billing.applyManualPlanPayment(client, plans.getPlan("i4_combo_10i_4v_v1"), "synthetic-paid-plan", new Date());
  atomicWriteJson(clientsPath, { [owner]: client });
  const readClients = () => JSON.parse(fs.readFileSync(clientsPath, "utf8"));
  const writeClients = value => atomicWriteJson(clientsPath, value);
  let connection = options.connection === undefined ? healthy : options.connection, observations = 0, preparations = 0;
  const deps = { dataDir: root, planningDir: path.join(root, "planning"), ordersDir: path.join(root, "orders"), secret,
    readClients, writeClients, admissionEnabled: options.admissionEnabled !== false,
    prepareCalendarRequest: async () => { preparations++; return null; },
    observeConnection: async () => { observations++; if (connection instanceof Error) throw connection; return connection; }, ...options.ports };
  const service = createEditCalendarService(deps); t.after(() => service.close());
  const claims = { whatsapp: owner, sub: owner, company_id: owner, token_version: 2,
    iss: "ia4tube-api", aud: "ia4tube-client", jti: crypto.randomUUID() };
  const input = destination => ({ requestId: crypto.randomUUID(), date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    time: "17:51", destination, caption: "Legenda escolhida" });
  const body = (ticket, mediaKind) => ({ schemaVersion: 1, ticket, editOrderId: admissionOrderId(ticket),
    requestHash: hash(`synthetic-${mediaKind}`), mediaKind, title: "Modelo sintético", caption: "Legenda escolhida",
    durationSeconds: mediaKind === "image" ? null : 10,
    selection: { modelId: crypto.randomUUID(), modelVersion: 1, sourceDigest: hash("synthetic-catalog") }, quantity: 1 });
  const bindBody = request => ({ ticket: request.ticket, editOrderId: request.editOrderId, title: request.title,
    caption: request.caption, mediaKind: request.mediaKind, durationSeconds: request.durationSeconds, inputHash: hash("synthetic-result") });
  const source = createCalendarSource({ dataDir: root, planningDir: deps.planningDir, ordersDir: deps.ordersDir });
  return { root, owner, readClients, writeClients, service, deps, claims, input, body, bindBody, source,
    setConnection: value => { connection = value; }, observations: () => observations, preparations: () => preparations };
}

test("legacy reel context keeps its exact serialized request and never adds a connection lookup", async t => {
  const f = fixture(t, { connection: new Error("legacy must not observe") }), input = f.input("reel"), before = f.readClients();
  const expected = { requestId: input.requestId, date: input.date, time: input.time, destination: "reel", caption: input.caption };
  assert.deepEqual(contextInput(input, Date.now()), expected);
  const created = await f.service.createContext(f.claims, input);
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, "private/edit-calendar/contexts", input.requestId + ".json")));
  assert.equal(stored.requestHash, hash(JSON.stringify(expected))); assert.deepEqual(stored.request, expected);
  assert.deepEqual(await f.service.createContext(f.claims, input), created);
  assert.equal(f.observations(), 0); assert.deepEqual(f.readClients(), before);
});

for (const destination of ["feed", "story", "both"]) for (const mediaKind of ["image", "video"])
  test(`${mediaKind} ${destination} intent reaches its one reservation and existing calendar source unchanged`, async t => {
    const f = fixture(t), input = f.input(destination), before = f.readClients()[f.owner];
    const ctx = await f.service.createContext(f.claims, input), request = f.body(ctx.ticket, mediaKind);
    const admitted = await f.service.admit(request);
    assert.deepEqual(await f.service.admit(request), admitted);
    const bound = f.service.bind(f.bindBody(request)); assert.deepEqual(f.service.bind(f.bindBody(request)), bound);
    const client = f.readClients()[f.owner], imageUnits = mediaKind === "image" ? 1 : 0, videoUnits = mediaKind === "video" ? 1 : 0;
    assert.equal(client.artes_mensais_restantes, before.artes_mensais_restantes - imageUnits);
    assert.equal(client.videos_mensais_restantes, before.videos_mensais_restantes - videoUnits);
    assert.equal(Object.keys(client.planejamento_mensal_reservas).length, 1);
    const plan = planning.findPlanningById({ baseDir: f.deps.planningDir, whatsapp: f.owner, planningId: bound.planningId });
    assert.equal(plan.instagram_destination, destination); assert.equal(plan.edit_calendar.mediaKind, mediaKind);
    const items = f.source.list(f.owner); assert.equal(items.length, 1);
    assert.equal(items[0].destination, destination);
    assert.equal(items[0].date, input.date); assert.equal(items[0].time, input.time);
  });

for (const destination of ["feed", "story", "both", "reel"])
  test(`legacy bind without admission preserves explicit ${destination} and spends exactly one image`, async t => {
    const f = fixture(t, { admissionEnabled: false }), input = f.input(destination);
    const { ticket } = await f.service.createContext(f.claims, input), request = f.body(ticket, "image");
    f.service.bind(f.bindBody(request)); f.service.bind(f.bindBody(request));
    assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 9);
    assert.equal(f.source.list(f.owner)[0].destination, destination === "reel" ? "feed" : destination);
  });

for (const connection of [null, { ...healthy, accountType: "creator" }])
  test(`unsupported Story intent is refused before a context, reservation or preparation; type=${connection?.accountType || "none"}`, async t => {
    const f = fixture(t, { connection }), before = f.readClients(), input = f.input("both");
    await assert.rejects(f.service.createContext(f.claims, input), { code: "edit_calendar_story_business_required", statusCode: 409 });
    assert.deepEqual(f.readClients(), before); assert.equal(f.preparations(), 0);
    assert.equal(fs.existsSync(path.join(f.root, "private/edit-calendar")), false);
    // Unchecking Story can reuse this not-yet-issued request ID without a duplicate debit.
    await f.service.createContext(f.claims, { ...input, destination: "feed" });
    assert.deepEqual(f.readClients(), before); assert.equal(f.preparations(), 1);
  });

test("failed observation does not invent Story eligibility or create a pending debit", async t => {
  const f = fixture(t, { connection: new Error("synthetic read unavailable") }), before = f.readClients();
  await assert.rejects(f.service.createContext(f.claims, f.input("story")), { code: "edit_calendar_admission_unavailable", statusCode: 503 });
  assert.deepEqual(f.readClients(), before); assert.equal(fs.existsSync(path.join(f.root, "private/edit-calendar")), false);
});

test("an issued pending Story intent is replayed from its frozen receipt and cannot change destinations", async t => {
  const f = fixture(t), input = f.input("both"), ctx = await f.service.createContext(f.claims, input);
  f.setConnection(new Error("later observation unavailable"));
  assert.deepEqual(await f.service.createContext(f.claims, input), ctx); assert.equal(f.observations(), 1);
  await assert.rejects(f.service.createContext(f.claims, { ...input, destination: "feed" }), { code: "edit_calendar_context_conflict" });
});

test("finished-photo context reports the frozen choice while availability v1 stays exact", async t => {
  const f = fixture(t), { ticket } = await f.service.createContext(f.claims, f.input("both"));
  const result = await f.service.readReadyImageContext(ticket); assert.equal(result.destination, "both");
  assert.deepEqual(Object.keys((await f.service.availability(f.claims)).availability).sort(),
    ["canImage", "canVideo", "observedAt", "schemaVersion", "validUntil"]);
});

test("unknown, empty and client-picked extra placement fields are rejected before writing", async t => {
  const f = fixture(t);
  for (const destination of ["reels", "", null, false, ["feed", "story"]])
    await assert.rejects(f.service.createContext(f.claims, f.input(destination)), { code: "edit_calendar_input_invalid" });
  await assert.rejects(f.service.createContext(f.claims, { ...f.input("feed"), owner: "other" }), { code: "edit_calendar_input_invalid" });
  assert.equal(f.preparations(), 0); assert.equal(f.observations(), 0);
});

test("Story eligibility observation cannot bypass an account deactivated during the read", async t => {
  let f;
  f = fixture(t, { ports: { observeConnection: async () => {
    const clients = f.readClients(); clients[f.owner].ativo = false; f.writeClients(clients); return healthy;
  } } });
  await assert.rejects(f.service.createContext(f.claims, f.input("both")), { code: "edit_calendar_session_required" });
  assert.equal(fs.existsSync(path.join(f.root, "private/edit-calendar")), false);
});

test("context HTTP returns a usable Story explanation before quota is consumed", async t => {
  const f = fixture(t, { connection: { ...healthy, accountType: "creator" } }), before = f.readClients();
  const app = express(); app.use(express.json()); app.use(createEditCalendarRouter({
    authenticate: (req, _res, next) => { req.user = f.claims; next(); }, botAuthenticate: (_req, res) => res.sendStatus(401),
    isBotAdmin: () => false, service: f.service }));
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await fetch(`http://127.0.0.1:${server.address().port}/empresa/edit/context`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f.input("both")) });
  assert.equal(result.status, 409);
  const body = await result.json(); assert.equal(body.code, "edit_calendar_story_business_required");
  assert.equal(body.error, "Story exige uma conta Instagram Empresa. Desmarque Story para continuar.");
  assert.deepEqual(f.readClients(), before);
});
