"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), express = require("express");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { createEditCalendarRouter } = require("../src/company-edit-calendar/router");
const { atomicWriteJson } = require("../src/notifications/fcm-token-store");
const billing = require("../src/billing/billing.service"), plans = require("../src/billing/plans");
const secret = "synthetic-ready-image-context-fixture-not-a-real-secret";
const healthy = { provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "123456789012345" };

async function fixture(t, options = {}) {
  const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, "ia4tube-image-context-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), temp); assert.ok(path.basename(resolved).startsWith("ia4tube-image-context-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const owner = "synthetic-context-owner", clientsFile = path.join(root, "clients.json");
  const client = { ativo: true, arte_gratis_usada: options.free !== true, arte_gratis_disponivel: options.free === true,
    arte_gratis_usos: [], artes_avulsas_restantes: 2, nome_empresa: "Loja sintética", ramo: "Loja" };
  if (options.paid !== false) billing.applyManualPlanPayment(client, plans.getPlan("i4_combo_10i_4v_v1"), "synthetic-context-plan", new Date());
  else Object.assign(client, { plano_status: "none", artes_mensais_restantes: 0, artes_avulsas_restantes: 0 });
  Object.assign(client, options.client);
  atomicWriteJson(clientsFile, { [owner]: client });
  const readClients = () => JSON.parse(fs.readFileSync(clientsFile, "utf8"));
  const writeClients = value => atomicWriteJson(clientsFile, value);
  let now = Date.now(), observations = 0, prepares = 0;
  const dependencies = { dataDir: root, secret, readClients, writeClients, admissionEnabled: true, clock: () => now,
    prepareCalendarRequest: async () => { prepares++; return null; },
    observeConnection: async () => { observations++; return options.connection === undefined ? healthy : options.connection; }, ...options.ports };
  const service = createEditCalendarService(dependencies); t.after(() => service.close());
  const claims = { whatsapp: owner, sub: owner, company_id: owner, token_version: 2,
    iss: "ia4tube-api", aud: "ia4tube-client", jti: crypto.randomUUID() };
  const input = { requestId: crypto.randomUUID(), date: new Date(now + 2 * 86400000).toISOString().slice(0, 10),
    time: "16:43", destination: "reel" };
  const { ticket } = await service.createContext(claims, input);
  const contextPath = path.join(root, "private/edit-calendar/contexts", `${input.requestId}.json`);
  return { root, owner, client, service, input, ticket, contextPath, readClients, writeClients, dependencies,
    observations: () => observations, prepares: () => prepares, setNow: value => { now = value; }, now: () => now };
}

async function assertNoWrites(action) {
  const attempted = [], originals = new Map();
  for (const name of ["mkdirSync", "writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync", "truncateSync", "writeSync", "chmodSync", "chownSync"]) {
    originals.set(name, fs[name]); fs[name] = () => { attempted.push(name); throw new Error("Read must not write"); };
  }
  const open = fs.openSync;
  fs.openSync = (file, flags, ...args) => {
    if (typeof flags === "string" ? /[wa+]/.test(flags) : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0) {
      attempted.push("open-write"); throw new Error("Read must not open for write");
    }
    return open(file, flags, ...args);
  };
  try { return await action(); }
  finally { for (const [name, original] of originals) fs[name] = original; fs.openSync = open; assert.deepEqual(attempted, []); }
}

test("context read returns native date/time and paid plus standalone count without any writes or preparation", async t => {
  const f = await fixture(t), before = f.readClients(), contextBefore = fs.readFileSync(f.contextPath);
  const result = await assertNoWrites(() => f.service.readReadyImageContext(f.ticket));
  assert.deepEqual(result, { ok: true, requestId: f.input.requestId, date: f.input.date, time: "16:43", remainingImages: 12 });
  assert.deepEqual(f.readClients(), before); assert.deepEqual(fs.readFileSync(f.contextPath), contextBefore);
  assert.equal(f.observations(), 0); assert.equal(f.prepares(), 1);
  assert.equal(fs.existsSync(path.join(f.root, "private/edit-calendar/free-image-ledger.json")), false);
  assert.equal(fs.existsSync(path.join(f.root, "private/edit-calendar/ready-images")), false);
});

for (const paid of [false, true]) test(`an eligible Instagram gift is counted once without creating a ledger; paid=${paid}`, async t => {
  const f = await fixture(t, { free: true, paid }), before = f.readClients();
  const result = await assertNoWrites(() => f.service.readReadyImageContext(f.ticket));
  assert.equal(result.remainingImages, paid ? 13 : 1);
  assert.equal(f.observations(), 1); assert.deepEqual(f.readClients(), before);
  assert.equal(fs.existsSync(path.join(f.root, "private/edit-calendar/free-image-ledger.json")), false);
  assert.equal((await assertNoWrites(() => f.service.readReadyImageContext(f.ticket))).remainingImages, result.remainingImages);
});

test("a disconnected Instagram has no gift; an unavailable observation yields unknown instead of inventing a count", async t => {
  const disconnected = await fixture(t, { free: true, paid: false, connection: null });
  assert.equal((await assertNoWrites(() => disconnected.service.readReadyImageContext(disconnected.ticket))).remainingImages, 0);
  const unavailable = await fixture(t, { free: true, ports: { observeConnection: async () => { throw new Error("synthetic read unavailable"); } } });
  const result = await assertNoWrites(() => unavailable.service.readReadyImageContext(unavailable.ticket));
  assert.equal(result.remainingImages, null); assert.equal(result.date, unavailable.input.date); assert.equal(result.time, unavailable.input.time);
});

test("historical consumption and IP restriction do not create another gift", async t => {
  const historical = await fixture(t, { free: true, paid: false, client: { arte_gratis_usada: false, arte_gratis_pedido_id: "prior-art" } });
  assert.equal((await assertNoWrites(() => historical.service.readReadyImageContext(historical.ticket))).remainingImages, 0);
  assert.equal(historical.observations(), 0);
  const blocked = await fixture(t, { free: true, paid: false, ports: { currentFreeArtBlocked: () => true } });
  assert.equal((await assertNoWrites(() => blocked.service.readReadyImageContext(blocked.ticket))).remainingImages, 0);
});

test("an existing reserved gift is not counted as another available image", async t => {
  const f = await fixture(t, { free: true, paid: false });
  const ledgerPath = path.join(f.root, "private/edit-calendar/free-image-ledger.json");
  // Build the actual existing ledger through the existing admission in a separate context.
  const { admissionOrderId, hash } = require("../src/company-edit-calendar/admission-contract");
  const request = { schemaVersion: 1, ticket: f.ticket, editOrderId: admissionOrderId(f.ticket), requestHash: hash("synthetic-reserved"),
    mediaKind: "image", title: "Modelo sintético", caption: "Legenda", durationSeconds: null,
    selection: { modelId: crypto.randomUUID(), modelVersion: 1, sourceDigest: hash("synthetic-catalog") }, quantity: 1 };
  await f.service.admit(request);
  assert.equal(fs.existsSync(ledgerPath), true);
  const claims = { whatsapp: f.owner, sub: f.owner, company_id: f.owner, token_version: 2,
    iss: "ia4tube-api", aud: "ia4tube-client", jti: crypto.randomUUID() };
  const next = await f.service.createContext(claims, { ...f.input, requestId: crypto.randomUUID() });
  const before = fs.readFileSync(ledgerPath);
  assert.equal((await assertNoWrites(() => f.service.readReadyImageContext(next.ticket))).remainingImages, 0);
  assert.deepEqual(fs.readFileSync(ledgerPath), before);
});

test("unreadable legacy-free eligibility returns null without repairs or migrations", async t => {
  const f = await fixture(t, { free: true }), ledgerPath = path.join(f.root, "private/edit-calendar/free-image-ledger.json");
  fs.writeFileSync(ledgerPath, "{}");
  const result = await assertNoWrites(() => f.service.readReadyImageContext(f.ticket));
  assert.equal(result.remainingImages, null); assert.equal(fs.readFileSync(ledgerPath, "utf8"), "{}");
});

test("the count is rechecked after the connection read, and account deactivation is not ignored", async t => {
  let fixtureRef;
  const f = await fixture(t, { free: true, ports: { observeConnection: async () => {
    const clients = fixtureRef.readClients(); clients[fixtureRef.owner].artes_mensais_restantes = 7; fixtureRef.writeClients(clients); return healthy;
  } } }); fixtureRef = f;
  assert.equal((await f.service.readReadyImageContext(f.ticket)).remainingImages, 10); // 7 monthly + 2 standalone + 1 gift
  const blocked = await fixture(t, { free: true, ports: { observeConnection: async () => {
    const clients = fixtureRef.readClients(); clients[fixtureRef.owner].ativo = false; fixtureRef.writeClients(clients); return healthy;
  } } }); fixtureRef = blocked;
  await assert.rejects(blocked.service.readReadyImageContext(blocked.ticket), { code: "edit_calendar_session_required" });
});

test("forged, expired and inactive contexts fail without writes", async t => {
  const f = await fixture(t);
  await assert.rejects(assertNoWrites(() => f.service.readReadyImageContext(f.ticket.slice(0, 37) + "x".repeat(43))),
    { code: "edit_calendar_context_unavailable" });
  const row = JSON.parse(fs.readFileSync(f.contextPath, "utf8")); f.setNow(row.expiresAt);
  await assert.rejects(assertNoWrites(() => f.service.readReadyImageContext(f.ticket)), { code: "edit_calendar_context_expired" });
  f.setNow(row.createdAt); const clients = f.readClients(); clients[f.owner].ativo = false; f.writeClients(clients);
  await assert.rejects(assertNoWrites(() => f.service.readReadyImageContext(f.ticket)), { code: "edit_calendar_session_required" });
});

test("expiration during the optional connection observation is checked again", async t => {
  let fixtureRef;
  const f = await fixture(t, { free: true, ports: { observeConnection: async () => {
    const row = JSON.parse(fs.readFileSync(fixtureRef.contextPath, "utf8")); fixtureRef.setNow(row.expiresAt); return healthy;
  } } }); fixtureRef = f;
  await assert.rejects(assertNoWrites(() => f.service.readReadyImageContext(f.ticket)), { code: "edit_calendar_context_expired" });
});

test("HTTP read needs the ticket header, does not accept URL credentials or dates, and keeps availability v1 exact", async t => {
  const f = await fixture(t); let uploads = 0;
  const app = express(); app.use(createEditCalendarRouter({ authenticate: (_req, res) => res.sendStatus(401),
    botAuthenticate: (_req, res) => res.sendStatus(401), isBotAdmin: () => false, service: f.service,
    readyImageUpload: () => { uploads++; } }));
  const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/empresa/edit/ready-images/context`, headers = { Authorization: `EditTicket ${f.ticket}` };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url + "?ticket=" + f.ticket)).status, 401);
  assert.equal((await fetch(url + "?date=2099-01-01", { headers })).status, 400);
  const result = await fetch(url, { headers }); assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { ok: true, requestId: f.input.requestId, date: f.input.date, time: f.input.time, remainingImages: 12 });
  assert.equal(uploads, 0);
  const before = f.readClients(), availability = await f.service.availability({ whatsapp: f.owner });
  assert.deepEqual(Object.keys(availability.availability).sort(), ["canImage", "canVideo", "observedAt", "schemaVersion", "validUntil"]);
  assert.deepEqual(f.readClients(), before);
});
