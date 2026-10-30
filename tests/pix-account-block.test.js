"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const plans = require("../src/billing/plans");
const serverPath = path.join(__dirname, "../server.js");
const serverSource = fs.readFileSync(serverPath, "utf8");
const policySource = fs.readFileSync(path.join(__dirname, "../src/billing/pix-account-policy.js"), "utf8");
const blocked = "47999999999", blockedCountry = "5547999999999", allowed = "synthetic-other-owner";
const planId = "i4_combo_10i_4v_v1";
const routes = [
  "/billing/arte-avulsa/pix", "/billing/artes-avulsas/pix", "/billing/saldo/pix", "/billing/planos/:planId/pix",
  "/comprar-creditos", "/comprar-creditos-pix", "/pedidos/:id/gerar-pix"
];
const plain = value => JSON.parse(JSON.stringify(value));

function policy(logs) {
  const context = { module: { exports: {} }, console: { warn: (...args) => logs.push(args) } };
  vm.runInNewContext(policySource, context, { filename: "isolated-pix-account-policy.js", timeout: 1000 });
  return context.module.exports;
}

function sliceBetween(startText, endText) {
  const start = serverSource.indexOf(startText), end = serverSource.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "The isolated fixture must find both explicit source boundaries");
  return serverSource.slice(start, end);
}

function routeSource(method, route) {
  const start = serverSource.indexOf(`app.${method}("${route}"`);
  assert.ok(start >= 0, `Missing registered route ${method} ${route}`);
  const next = /^app\.(?:get|post|put|delete|patch|use)\(/gm;
  next.lastIndex = start + 1;
  const end = next.exec(serverSource);
  assert.ok(end, "The fixture must stop before another application registration");
  return serverSource.slice(start, end.index);
}

function fixture(owner, options = {}) {
  assert.equal(require.cache[serverPath], undefined, "Never import or initialize the application server");
  const calls = { fetch: [], writes: [], pending: [], logs: [], guards: 0, mpWrites: [] }, registered = new Map();
  const client = { ativo: true, artes_avulsas_restantes: 0 }, clients = { [owner]: client };
  const order = { pagamento_pendente: true, valor_pendente: 5.99, ...(options.order || {}) };
  const api = policy(calls.logs);
  const providerData = { id: "synthetic-payment", status: "pending", init_point: "https://synthetic.invalid/checkout",
    sandbox_init_point: "https://synthetic.invalid/sandbox", point_of_interaction: { transaction_data: {
      qr_code: "synthetic-qr", qr_code_base64: "synthetic-base64", ticket_url: "https://synthetic.invalid/receipt" } }, ...options.providerData };
  const app = {};
  for (const method of ["get", "post"]) app[method] = (route, ...handlers) => registered.set(`${method.toUpperCase()} ${route}`, handlers.at(-1));
  const context = vm.createContext({
    app, auth: () => {}, path, Date, Number, String, JSON, Math,
    MP_ACCESS_TOKEN: options.noToken ? "" : "synthetic-not-a-real-provider-credential", MP_NOTIFICATION_URL: "https://synthetic.invalid/webhook",
    console: { warn: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args), log: (...args) => calls.logs.push(args) },
    assertPixIssuanceAllowed(value) { calls.guards++; return api.assertPixIssuanceAllowed(value); },
    sendBlockedPixError: api.sendBlockedPixError,
    crypto: { randomBytes: () => Buffer.from("01020304", "hex") }, billingPlans: plans,
    billingService: {
      roundMoney: value => Number(Number(value).toFixed(2)),
      recordStandaloneArtPurchasePending(value, receipt) { calls.pending.push(plain(receipt)); value.syntheticPending = true; },
      refreshManualPlanCycle: () => ({ changed: false }), getBillingStatus: () => ({ syntheticStatus: true })
    },
    readClientes: () => clients, writeClientes: value => calls.writes.push({ kind: "clients", value: plain(value) }),
    getPedidoBase: () => "/synthetic/order", safeReadJson: () => order,
    isAdminFreeArtOrderHidden: () => false, freeArtCampaignsService: { isFreeArtOrder: () => false },
    fs: { writeFileSync: (file, data) => calls.writes.push({ kind: "order", file, value: JSON.parse(data) }) },
    readMpProcessados: () => ({}), writeMpProcessados: value => calls.mpWrites.push(plain(value)), isMpProcessandoStale: () => false,
    async fetch(url, init = {}) {
      calls.fetch.push({ url, method: init.method || "GET", headers: plain(init.headers || {}), body: init.body ? JSON.parse(init.body) : null });
      return { ok: options.providerOk !== false, json: async () => plain(providerData) };
    }
  });
  // Only definitions/route registrations execute. No app listener, env reader, timers, real fetch or real filesystem port exists in this VM.
  new vm.Script(sliceBetween("async function createMercadoPagoPixPayment(", 'app.post("/webhook/mercadopago"'),
    { filename: "isolated-pix-issuance-routes.js" }).runInContext(context, { timeout: 1000 });
  for (const [method, route] of [["post", "/pedidos/:id/gerar-pix"], ["get", "/pedidos/:id/pagamento-info"], ["post", "/webhook/mercadopago"]])
    new vm.Script(routeSource(method, route), { filename: "isolated-pix-existing-payment-route.js" }).runInContext(context, { timeout: 1000 });

  async function run(route, values = {}) {
    const method = values.method || "POST", handler = registered.get(`${method} ${route}`);
    assert.equal(typeof handler, "function");
    const req = { user: { whatsapp: owner }, params: { id: "synthetic-order", planId }, query: {},
      body: { pacote: route.startsWith("/comprar-") ? "saldo_800" : "saldo_990", quantidade: 1, whatsapp: allowed },
      path: route.replace(":planId", planId).replace(":id", "synthetic-order"), ip: "192.0.2.10",
      headers: { "user-agent": "synthetic-test-agent", authorization: "Bearer synthetic-must-not-be-logged" }, ...values };
    const res = { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(value) { this.body = plain(value); return this; } };
    await handler(req, res);
    return { req, res };
  }
  return { calls, client, clients, order, context, api, run };
}

for (const owner of [blocked, blockedCountry]) for (const route of routes) test(`blocked identity ${owner === blocked ? "national" : "country alias"} cannot issue through ${route}`, async () => {
  const f = fixture(owner), before = plain(f.clients), beforeOrder = plain(f.order);
  const { res } = await f.run(route);
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, "pix_account_blocked");
  assert.equal(f.calls.fetch.length, 0); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.pending.length, 0);
  assert.deepEqual(f.clients, before); assert.deepEqual(f.order, beforeOrder);
  assert.equal(f.calls.logs.length, 1);
});

for (const route of routes) test(`another JWT owner keeps its normal flow despite body.whatsapp being blocked: ${route}`, async () => {
  const f = fixture(allowed);
  const { res } = await f.run(route, { body: { pacote: route.startsWith("/comprar-") ? "saldo_800" : "saldo_990", quantidade: 1, whatsapp: blocked } });
  assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true); assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.logs.length, 0);
  const sent = f.calls.fetch[0]; assert.equal(sent.method, "POST"); assert.equal(sent.body.metadata.whatsapp, allowed);
  assert.equal(sent.body.external_reference.includes(blocked), false);
  if (route === "/comprar-creditos") {
    assert.equal(sent.url, "https://api.mercadopago.com/checkout/preferences"); assert.equal(sent.body.items[0].unit_price, 8);
  } else {
    assert.equal(sent.url, "https://api.mercadopago.com/v1/payments"); assert.equal(sent.body.payment_method_id, "pix");
    const amount = route.includes("arte-avulsa") || route.includes("artes-avulsas") || route.includes("/pedidos/") ? 5.99
      : route.includes("/planos/") ? plans.getPurchasablePlan(planId).price : route === "/comprar-creditos-pix" ? 8 : 9.90;
    assert.equal(sent.body.transaction_amount, amount);
  }
});

for (const account of [blocked, blockedCountry, " (47) 99999-9999 ", "+55 (47) 99999-9999", Number(blocked)])
  test(`pure policy rejects the blocked phone spelling ${typeof account === "number" ? "numeric" : account.includes("+") ? "formatted country" : "normalized variant"}`, () => {
    const api = policy([]);
    assert.throws(() => api.assertPixIssuanceAllowed(account), error => error.code === "pix_account_blocked" && error.statusCode === 403);
  });

test("pure policy leaves other identifiers and longer phone-like strings unchanged", () => {
  const api = policy([]);
  for (const value of [allowed, "synthetic-" + blocked, blocked + "0", "47888888888", "5547888888888", "", null, undefined])
    assert.doesNotThrow(() => api.assertPixIssuanceAllowed(value));
});

test("the real central helper blocks before even checking a provider credential", async () => {
  const f = fixture(blocked, { noToken: true });
  await assert.rejects(f.context.createMercadoPagoPixPayment({ payerKey: blocked, amount: 149.90 }),
    error => error.code === "pix_account_blocked" && error.statusCode === 403);
  assert.equal(f.calls.fetch.length, 0); assert.equal(f.calls.writes.length, 0);
});

for (const owner of [blocked, blockedCountry, allowed]) test(`an existing pending order Pix is returned without issuing again: ${owner === allowed ? "other" : owner === blocked ? "national" : "country alias"}`, async () => {
  const original = { mp_payment_id: "synthetic-old-payment", pix_copia_cola: "synthetic-old-qr", mp_payment_status: "pending",
    pix_qr_code_base64: "synthetic-old-base64", pix_ticket_url: "https://synthetic.invalid/old-receipt" };
  const f = fixture(owner, { order: original }), before = plain(f.order);
  const { res } = await f.run("/pedidos/:id/gerar-pix");
  assert.equal(res.statusCode, 200); assert.equal(res.body.payment_id, original.mp_payment_id); assert.equal(res.body.pix_copia_cola, original.pix_copia_cola);
  assert.equal(f.calls.guards, 0); assert.equal(f.calls.fetch.length, 0); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.logs.length, 0);
  assert.deepEqual(f.order, before);
});

for (const owner of [blocked, blockedCountry]) test(`payment information remains readable for ${owner === blocked ? "national" : "country alias"} identity`, async () => {
  const f = fixture(owner, { order: { mp_payment_id: "synthetic-existing", pix_copia_cola: "synthetic-existing-qr" } });
  const { res } = await f.run("/pedidos/:id/pagamento-info", { method: "GET" });
  assert.equal(res.statusCode, 200); assert.equal(res.body.payment_id, "synthetic-existing");
  assert.equal(f.calls.guards, 0); assert.equal(f.calls.fetch.length, 0); assert.equal(f.calls.writes.length, 0);
});

test("billing status is not a Pix issuance and remains available", async () => {
  const f = fixture(blocked), { res } = await f.run("/billing/status", { method: "GET" });
  assert.equal(res.statusCode, 200); assert.equal(res.body.syntheticStatus, true);
  assert.equal(f.calls.guards, 0); assert.equal(f.calls.fetch.length, 0); assert.equal(f.calls.writes.length, 0);
});

test("webhook can inspect the existing pending payment without invoking the issuance guard", async () => {
  const f = fixture(blocked, { providerData: { metadata: { whatsapp: blocked }, status: "pending" } });
  const { res } = await f.run("/webhook/mercadopago", { body: { data: { id: "synthetic-existing-payment" } } });
  assert.equal(res.statusCode, 200); assert.equal(res.body.status, "pending"); assert.equal(f.calls.guards, 0);
  assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.fetch[0].method, "GET");
  assert.equal(f.calls.fetch[0].url, "https://api.mercadopago.com/v1/payments/synthetic-existing-payment");
  assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.logs.length, 0);
});

test("a normal provider failure keeps the previous error and cannot write a pending purchase", async () => {
  const f = fixture(allowed, { providerOk: false }), { res } = await f.run("/billing/arte-avulsa/pix");
  assert.equal(res.statusCode, 500); assert.equal(res.body.error, "Erro ao gerar Pix");
  assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.pending.length, 0); assert.equal(f.calls.logs.length, 0);
});

test("the blocked response logs only bounded routing metadata and never the body or authorization", () => {
  const logs = [], api = policy(logs);
  let error; try { api.assertPixIssuanceAllowed(blocked); } catch (value) { error = value; }
  const req = { originalUrl: "/billing/arte-avulsa/pix?synthetic-sensitive-query", ip: "x".repeat(100),
    headers: { "user-agent": "u".repeat(300), authorization: "Bearer synthetic-do-not-log" }, body: { senha: "synthetic-do-not-log-body" } };
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.value = plain(value); return this; } };
  assert.equal(api.sendBlockedPixError(error, req, res), true); assert.equal(res.code, 403); assert.equal(logs.length, 1);
  const log = JSON.parse(logs[0][1]); assert.equal(log.route, "/billing/arte-avulsa/pix"); assert.equal(log.ip.length, 80); assert.equal(log.user_agent.length, 200);
  assert.equal(JSON.stringify(logs).includes("synthetic-sensitive-query"), false); assert.equal(JSON.stringify(logs).includes("synthetic-do-not-log"), false);
  assert.deepEqual(Object.keys(log).sort(), ["account", "ip", "route", "user_agent"]);
});

test("other errors are not converted to a Pix block or logged", () => {
  const logs = [], api = policy(logs), res = { status() { assert.fail("Unexpected blocked response"); } };
  assert.equal(api.sendBlockedPixError(new Error("synthetic other error"), {}, res), false); assert.equal(logs.length, 0);
});

test("the test never imports server.js", () => { assert.equal(require.cache[serverPath], undefined); });
