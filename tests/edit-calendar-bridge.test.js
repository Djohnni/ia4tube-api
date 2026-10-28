"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"),
  os = require("node:os"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const express = require("express");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { createEditCalendarRouter } = require("../src/company-edit-calendar/router");
const planning = require("../src/company-monthly-planning/planning.service");
const orders = require("../src/orders/order.storage");
const { createCalendarSource } = require("../src/social/calendar/source");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const { atomicWriteJson } = require("../src/notifications/fcm-token-store");
const secret = "synthetic-edit-calendar-bridge-secret-only-20261028";
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-edit-calendar-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = "synthetic-owner", other = "synthetic-other";
  const clientsPath = path.join(root, "clients.json"), planningDir = path.join(root, "planning"), ordersDir = path.join(root, "orders");
  const client = { ativo: true, whatsapp: owner, nome_empresa: "Loja sintética", ramo: "Loja", plano_status: "active",
    plano_renova_em: "2099-01-01", plano_ciclo: "2099-01", artes_mensais_total: 20, artes_mensais_restantes: 20, artes_avulsas_restantes: 0 };
  atomicWriteJson(clientsPath, { [owner]: client, [other]: { ...client, whatsapp: other } });
  const readClients = () => JSON.parse(fs.readFileSync(clientsPath, "utf8"));
  const writeClients = value => atomicWriteJson(clientsPath, value);
  const companyId = crypto.randomUUID(), userId = crypto.randomUUID();
  const grants = createCalendarGrants(secret); t.after(() => grants.close());
  const binding = { connectionId: crypto.randomUUID(), externalId: "123456789012345", connectionRevision: 1 };
  let automatic = true, now = Date.now();
  const dependencies = { dataDir: root, planningDir, ordersDir, secret, readClients, writeClients, clock: () => now,
    prepareCalendarRequest: async () => automatic ? ({ planningId, quantity }) => grants.issue({ companyId, userId,
      binding: { ...binding }, revision: 2, planningId, quantity }) : null, ...options };
  const service = createEditCalendarService(dependencies); t.after(() => service.close());
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const contextBody = () => ({ requestId: crypto.randomUUID(), date: day, time: "14:00", destination: "reel" });
  const bindBody = ticket => ({ ticket, editOrderId: crypto.randomUUID(), title: "Modelo sintético", caption: "Legenda sintética",
    durationSeconds: 10, inputHash: "a".repeat(64) });
  const source = createCalendarSource({ dataDir: root, planningDir, ordersDir });
  return { root, owner, other, service, dependencies, contextBody, bindBody, readClients, writeClients, source,
    planningDir, ordersDir, companyId, userId, grants, binding, setAutomatic: value => { automatic = value; }, setNow: value => { now = value; } };
}
test("browsing creates an opaque idempotent context without charging, planning or image tasks", async t => {
  const f = fixture(t), body = f.contextBody(), before = f.readClients();
  const [first, retry] = await Promise.all([f.service.createContext({ whatsapp: f.owner }, body), f.service.createContext({ whatsapp: f.owner }, body)]);
  assert.deepEqual(first, retry); assert.match(first.ticket, /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.readClients(), before); assert.equal(fs.existsSync(f.planningDir), false);
  const context = JSON.parse(fs.readFileSync(path.join(f.root, "private/edit-calendar/contexts", `${body.requestId}.json`)));
  assert.equal(JSON.stringify(context).includes(first.ticket), false);
  assert.equal(JSON.stringify(context).includes(first.ticket.split(".")[1]), false);
  assert.equal(Object.hasOwn(first, "envelope"), false);
  await assert.rejects(f.service.createContext({ whatsapp: f.other }, body), { code: "edit_calendar_context_unavailable" });
});
test("binding uses normal image credit once and exactly one real source, outside both image queues", async t => {
  const f = fixture(t), context = await f.service.createContext({ whatsapp: f.owner }, f.contextBody()), body = f.bindBody(context.ticket);
  const [first, retry] = await Promise.all([Promise.resolve().then(() => f.service.bind(body)), Promise.resolve().then(() => f.service.bind(body))]);
  assert.deepEqual(first, retry); assert.deepEqual(Object.keys(first).sort(), ["editOrderId", "ok", "pedidoId", "planningId"]);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
  assert.equal(f.source.list(f.owner).length, 1); assert.equal(f.source.list(f.other).length, 0);
  const plan = planning.findPlanningById({ baseDir: f.planningDir, whatsapp: f.owner, planningId: first.planningId });
  assert.equal(plan.runner_contract.pronto_para_runner, false); assert.equal(plan.pedidos_criados.total, 1);
  assert.deepEqual(planning.listBotPending({ baseDir: f.planningDir, claim: false }).planejamentos, []);
  assert.deepEqual(planning.listPlanningArtPending({ pedidosDir: f.ordersDir }).artes, []);
  const child = planning.findPlanningArtOrder({ pedidosDir: f.ordersDir, pedidoId: first.pedidoId });
  assert.equal(child.status, "processando"); assert.equal(child.pedido.descricao_instagram, body.caption);
  planning.updatePlanningArtStatus({ pedidosDir: f.ordersDir, pedidoId: first.pedidoId, status: "novo" });
  assert.deepEqual(planning.listPlanningArtPending({ pedidosDir: f.ordersDir }).artes, [], "Edit routing also excludes manually reset status");
  const source = f.source.list(f.owner)[0];
  assert.equal(source.imageReady, false); assert.ok(f.grants.verify(source.authorizationEnvelope, f.companyId, f.userId));
});
test("a paused current image preference remains manual; it is never enabled by browsing or binding", async t => {
  const f = fixture(t); f.setAutomatic(false);
  const ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody()); f.service.bind(f.bindBody(ctx.ticket));
  assert.equal(f.source.list(f.owner)[0].authorizationEnvelope, null);
});
test("the existing signed image consent snapshots the connection at context creation", async t => {
  const f = fixture(t), original = { ...f.binding }, ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody());
  f.binding.connectionId = crypto.randomUUID(); f.binding.connectionRevision++;
  f.service.bind(f.bindBody(ctx.ticket));
  assert.deepEqual(f.grants.verify(f.source.list(f.owner)[0].authorizationEnvelope, f.companyId, f.userId).binding, original);
});
test("one ticket cannot be reused for another order, hash, title or duration", async t => {
  const f = fixture(t), ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody()), body = f.bindBody(ctx.ticket);
  f.service.bind(body);
  for (const change of [{ editOrderId: crypto.randomUUID() }, { inputHash: "b".repeat(64) }, { title: "Outro" }, { durationSeconds: 20 }])
    assert.throws(() => f.service.bind({ ...body, ...change }), { code: "edit_calendar_order_conflict" });
  const otherCtx = await f.service.createContext({ whatsapp: f.other }, f.contextBody());
  assert.throws(() => f.service.bind({ ...body, ticket: otherCtx.ticket }), { code: "edit_calendar_order_conflict" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19); assert.equal(f.readClients()[f.other].artes_mensais_restantes, 20);
});
test("expired unbound contexts refuse allocation; a completed exact retry remains stable after expiry", async t => {
  const f = fixture(t), pending = await f.service.createContext({ whatsapp: f.owner }, f.contextBody()),
    ready = await f.service.createContext({ whatsapp: f.owner }, f.contextBody()), body = f.bindBody(ready.ticket);
  const done = f.service.bind(body); f.setNow(Date.now() + 8 * 86400000);
  assert.throws(() => f.service.bind(f.bindBody(pending.ticket)), { code: "edit_calendar_context_expired" });
  assert.deepEqual(f.service.bind(body), done); assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
});
for (const stage of ["after_request", "before_client_commit", "after_client_commit"]) test(`crash recovery at ${stage} reuses IDs and never debits a second time`, async t => {
  let injected = false;
  const f = fixture(t, { fault: current => { if (current === stage && !injected) { injected = true; throw new Error("synthetic interruption"); } } });
  const ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody()), body = f.bindBody(ctx.ticket);
  assert.throws(() => f.service.bind(body), /synthetic interruption/);
  const fresh = createEditCalendarService({ ...f.dependencies, fault: () => {} }); t.after(() => fresh.close());
  const done = fresh.bind(body); assert.deepEqual(fresh.bind(body), done);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
  assert.equal(f.source.list(f.owner).length, 1); assert.equal(orders.listPedidoBasesByWhatsapp(f.ordersDir, f.owner).length, 1);
});
test("an actual stopped process is recovered using its durable billing receipt and dead lock", async t => {
  const f = fixture(t), ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody()), body = f.bindBody(ctx.ticket);
  const modulePath = require.resolve("../src/company-edit-calendar/service"), atomicPath = require.resolve("../src/notifications/fcm-token-store");
  const script = `const fs=require('node:fs');const{createEditCalendarService}=require(${JSON.stringify(modulePath)});const{atomicWriteJson}=require(${JSON.stringify(atomicPath)});const clients=${JSON.stringify(path.join(f.root, "clients.json"))};createEditCalendarService({dataDir:${JSON.stringify(f.root)},planningDir:${JSON.stringify(f.planningDir)},ordersDir:${JSON.stringify(f.ordersDir)},secret:${JSON.stringify(secret)},readClients:()=>JSON.parse(fs.readFileSync(clients,'utf8')),writeClients:v=>atomicWriteJson(clients,v),prepareCalendarRequest:async()=>null,fault:s=>{if(s==='after_client_commit')process.exit(41)}}).bind(${JSON.stringify(body)});`;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 41, child.stderr);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
  const done = f.service.bind(body); assert.deepEqual(f.service.bind(body), done);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19); assert.equal(f.source.list(f.owner).length, 1);
});
test("insufficient normal credits can be replenished without creating duplicate requests", async t => {
  const f = fixture(t), clients = f.readClients(); clients[f.owner].artes_mensais_restantes = 0; f.writeClients(clients);
  const ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody()), body = f.bindBody(ctx.ticket);
  assert.throws(() => f.service.bind(body), { code: "billing_required" });
  const credited = f.readClients(); credited[f.owner].artes_mensais_restantes = 2; f.writeClients(credited);
  const done = f.service.bind(body); assert.deepEqual(f.service.bind(body), done);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 1);
});
test("free-art IP receipt uses only the authenticated hash/mask and retries never consume another free art", async t => {
  let attempts = 0, observed = null;
  const f = fixture(t, { recordFreeArtUse: value => { attempts++; observed = value; return attempts > 1; } });
  const clients = f.readClients(); clients[f.owner].artes_mensais_restantes = 0;
  clients[f.owner].arte_gratis_disponivel = true; clients[f.owner].arte_gratis_usada = false; f.writeClients(clients);
  const identity = { ipHash: "c".repeat(64), ipMasked: "192.0.2.0" }, contextBody = f.contextBody();
  const ctx = await f.service.createContext({ whatsapp: f.owner }, contextBody, { ipIdentity: identity }), body = f.bindBody(ctx.ticket);
  assert.throws(() => f.service.bind(body), { code: "edit_calendar_free_art_receipt_unconfirmed" });
  const charged = f.readClients()[f.owner]; assert.equal(charged.arte_gratis_usada, true); assert.equal(charged.arte_gratis_usos.length, 1);
  const done = f.service.bind(body); assert.equal(attempts, 2); assert.equal(observed.planningId, done.planningId);
  assert.deepEqual(observed.ipIdentity, identity); assert.equal(Object.hasOwn(observed, "ip"), false);
  assert.equal(f.readClients()[f.owner].arte_gratis_usos.length, 1); assert.equal(f.source.list(f.owner).length, 1);
  f.service.bind(body); assert.equal(attempts, 2, "completed receipt is read-only");
  assert.deepEqual(Object.keys(ctx).sort(), ["expiresAt", "ok", "ticket"]);
});
test("an IP blocked after browsing uses the existing credit fallback rather than another free art", async t => {
  const f = fixture(t, { currentFreeArtBlocked: () => true });
  const clients = f.readClients(); clients[f.owner].artes_mensais_restantes = 0;
  clients[f.owner].arte_gratis_disponivel = true; clients[f.owner].arte_gratis_usada = false; f.writeClients(clients);
  const ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody(),
    { ipIdentity: { ipHash: "c".repeat(64), ipMasked: "192.0.2.0" } });
  assert.throws(() => f.service.bind(f.bindBody(ctx.ticket)), { code: "billing_required" });
  assert.equal(f.readClients()[f.owner].arte_gratis_usada, false);
});
test("unknown owners, extra identity fields and a forged ticket never allocate or expose the stored consent", async t => {
  const f = fixture(t), body = f.contextBody();
  await assert.rejects(f.service.createContext({ whatsapp: "missing" }, body), { code: "edit_calendar_session_required" });
  await assert.rejects(f.service.createContext({ whatsapp: f.owner }, { ...body, companyId: crypto.randomUUID() }), { code: "edit_calendar_input_invalid" });
  const ctx = await f.service.createContext({ whatsapp: f.owner }, body), forged = `${ctx.ticket.slice(0, 37)}${"x".repeat(43)}`;
  assert.throws(() => f.service.bind(f.bindBody(forged)), { code: "edit_calendar_context_unavailable" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 20);
});
test("existing result return preserves an explicit client caption and same authoritative source", async t => {
  const f = fixture(t), ctx = await f.service.createContext({ whatsapp: f.owner }, { ...f.contextBody(), caption: "Legenda escolhida pelo cliente" });
  const bound = f.service.bind(f.bindBody(ctx.ticket));
  const result = path.join(f.root, "synthetic.png"); fs.writeFileSync(result, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  planning.savePlanningArtResult({ pedidosDir: f.ordersDir, pedidoId: bound.pedidoId, resultadoPath: result, descricaoInstagram: "Legenda do operador" });
  const source = f.source.list(f.owner)[0]; assert.equal(source.caption, "Legenda escolhida pelo cliente");
  assert.equal(source.orderId, bound.pedidoId); assert.equal(source.imageReady, true);
});
test("HTTP context requires the current app session and binding requires an administrator runner", async t => {
  const f = fixture(t), app = express(); app.use(express.json());
  const authenticate = (req, res, next) => { if (req.headers.authorization !== "synthetic-app") return res.sendStatus(401); req.user = { whatsapp: f.owner }; next(); };
  const botAuthenticate = (req, res, next) => { if (req.headers.authorization !== "synthetic-bot") return res.sendStatus(401); req.user = { admin: req.headers["x-admin"] === "yes" }; next(); };
  app.use(createEditCalendarRouter({ authenticate, botAuthenticate, isBotAdmin: req => req.user.admin, service: f.service }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, authorization, extra = {}) => fetch(origin + route, { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { authorization } : {}), ...extra }, body: JSON.stringify(body) });
  assert.equal((await post("/empresa/edit/context", f.contextBody())).status, 401);
  const created = await post("/empresa/edit/context", f.contextBody(), "synthetic-app"), ctx = await created.json();
  assert.equal(created.status, 200); assert.equal(created.headers.get("cache-control"), "no-store");
  const body = f.bindBody(ctx.ticket);
  assert.equal((await post("/bot/empresa/edit/orders/bind", body, "synthetic-bot")).status, 403);
  const accepted = await post("/bot/empresa/edit/orders/bind", body, "synthetic-bot", { "x-admin": "yes" });
  assert.equal(accepted.status, 200); const json = await accepted.json();
  assert.equal(json.editOrderId, body.editOrderId); assert.equal(json.ok, true); assert.equal(Object.hasOwn(json, "ticket"), false);
});
