"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const billing = require("../src/billing/billing.service");
const plans = require("../src/billing/plans");
const planning = require("../src/company-monthly-planning/planning.service");

function oldUnusedClient() {
  return { ativo: true, nome_empresa: "Loja sintetica", ramo: "Loja", plano_status: "none",
    artes_mensais_restantes: 0, artes_avulsas_restantes: 0, saldo_extra: 0,
    arte_gratis_disponivel: true, arte_gratis_usada: false, arte_gratis_usos: [] };
}
function requestFixture(t, client = oldUnusedClient()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-free-policy-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(root), temp = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), temp, "fixture cleanup must stay directly inside the temporary directory");
    assert.ok(path.basename(resolved).startsWith("ia4tube-free-policy-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, client, request: (body = {}, internal = {}) => planning.createRequest({
    baseDir: path.join(root, "planning"), cliente: client, whatsapp: "synthetic-owner",
    body: { quantidade_reservada: 1, ...body }, files: {}, ...internal }) };
}
function admissionMarker(mediaKind = "image", kind = "edit_calendar_admission_v1") {
  return { kind, contextId: crypto.randomUUID(), editOrderId: crypto.randomUUID(), mediaKind,
    ...(kind === "edit_calendar_admission_v1" ? { admissionId: crypto.randomUUID(), requestHash: "a".repeat(64) }
      : { inputHash: "a".repeat(64) }) };
}

for (const value of [undefined, "false", "true"]) test(`signup gift stays disabled with old policy flag ${value}`, () => {
  const previous = process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY;
  try {
    if (value === undefined) delete process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY;
    else process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY = value;
    const client = {}; billing.markFreeArtEligible(client);
    assert.equal(client.arte_gratis_disponivel, false); assert.equal(client.arte_gratis_usada, false);
    assert.equal(billing.getFreeArtStatus(client).arte_gratis_disponivel, false);
    assert.deepEqual(client.arte_gratis_usos, []);
  } finally {
    if (previous === undefined) delete process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY;
    else process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY = previous;
  }
});

test("old unused flag no longer grants public status or a generic company order", () => {
  const client = oldUnusedClient();
  assert.equal(billing.getFreeArtStatus(client).arte_gratis_disponivel, false);
  assert.equal(billing.getBillingStatus(client).arte_gratis_disponivel, false);
  assert.equal(billing.hasAvailableFreeCompanyArt(client), false);
  const charge = billing.resolveCompanyArtCharge(client, { custoPedido: 5.99 });
  assert.equal(charge.allowed, false); assert.equal(charge.code, "billing_required");
  assert.equal(client.arte_gratis_disponivel, true, "do not rewrite historical entitlement fields during a read");
  assert.equal(client.arte_gratis_usada, false); assert.deepEqual(client.arte_gratis_usos, []);
});

for (const history of [{ arte_gratis_usada: true }, { arte_gratis_pedido_id: "old-order" },
  { arte_gratis_usos: [{ pedido_id: "old-order" }] }]) test(`consumed history cannot become a second benefit ${Object.keys(history)[0]}`, () => {
  const client = { ...oldUnusedClient(), ...history };
  assert.equal(billing.getFreeArtStatus(client, { instagramFreeClaim: true }).arte_gratis_disponivel, false);
  assert.equal(billing.getFreeArtStatus(client).arte_gratis_usada, true);
  const before = structuredClone(client); billing.markFreeArtEligible(client);
  for (const field of Object.keys(history)) assert.deepEqual(client[field], before[field]);
});

for (const body of [{}, { instagramFreeClaim: true }, { instagramFreeClaim: "true", freeArtBlocked: false },
  { instagramFreeClaim: true, externalEdit: admissionMarker(), billing: { instagramFreeClaim: true } }])
  test(`ordinary planning refuses old flags and untrusted body ${JSON.stringify(body)}`, t => {
    const f = requestFixture(t);
    assert.throws(() => f.request(body), { code: "billing_required" });
    assert.equal(f.client.arte_gratis_usada, false); assert.deepEqual(f.client.arte_gratis_usos, []);
    assert.equal(fs.existsSync(path.join(f.root, "planning")), false, "refuse before creating production inputs");
  });

test("an internal boolean alone cannot bypass the verified Edit admission marker", t => {
  for (const externalEdit of [null, admissionMarker("image", "edit_calendar_v1"), admissionMarker("video")]) {
    const f = requestFixture(t);
    assert.throws(() => f.request({}, { instagramFreeClaim: true, externalEdit }), { code: "billing_required" });
    assert.equal(f.client.arte_gratis_usada, false);
  }
});

test("a trusted image claim remains blocked by the existing IP decision", t => {
  const f = requestFixture(t);
  assert.throws(() => f.request({}, { instagramFreeClaim: true, externalEdit: admissionMarker(), freeArtBlocked: true }),
    { code: "billing_required" });
  assert.equal(f.client.arte_gratis_usada, false);
});

test("paid image and video pools retain their amounts despite an unused old free flag", t => {
  const client = oldUnusedClient();
  billing.applyManualPlanPayment(client, plans.getPlan("i4_combo_10i_4v_v1"),
    { paymentId: "synthetic-free-policy-paid", paidAt: new Date().toISOString() });
  assert.equal(billing.resolveCompanyArtCharge(client, { custoPedido: 5.99 }).source, "plano");
  const f = requestFixture(t, client); f.request();
  assert.equal(client.artes_mensais_restantes, 9); assert.equal(client.videos_mensais_restantes, 4);
  assert.equal(client.arte_gratis_usada, false); assert.deepEqual(client.arte_gratis_usos, []);
});

test("a standalone paid image remains spendable without Instagram", t => {
  const f = requestFixture(t, { ...oldUnusedClient(), artes_avulsas_restantes: 1 });
  assert.equal(billing.resolveCompanyArtCharge(f.client, { custoPedido: 5.99 }).source, "arte_avulsa");
  f.request(); assert.equal(f.client.artes_avulsas_restantes, 0); assert.equal(f.client.artes_avulsas_usadas, 1);
  assert.equal(f.client.arte_gratis_usada, false);
});
