"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const quota = require("../src/billing/story-quota"), billing = require("../src/billing/billing.service");
const { createStoryCheckout } = require("../src/billing/story-checkout");
const { createPromoRollout } = require("../src/billing/promo-rollout");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { admissionOrderId, hash } = require("../src/company-edit-calendar/admission-contract");
const clone = x => structuredClone(x);
const internal = createPromoRollout({ IA4TUBE_PROMO_INTERNAL_ACCOUNTS: " owner ", IA4TUBE_WELCOME_ART_ENABLED: "true" });
function checkoutFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-checkout-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clients = { owner: { untouched: "monthly-plan", artes_mensais_restantes: 10 }, other: { balance: 40 } }, calls = [];
  const ports = { root, readClients: () => clone(clients), writeClients: v => { clients = clone(v); }, assertAllowed: () => {},
    storyPackageFor: internal.storyPackageFor,
    issuePix: async input => { calls.push(input); return { data: { id: "123456", date_of_expiration: "2099-01-01" }, pixCopiaCola: "fake-qr" }; }, ...options };
  const service = createStoryCheckout(ports);
  const payment = input => ({ id: "123456", status: "approved", currency_id: "BRL", transaction_amount: 19.9,
    external_reference: input.externalReference, metadata: clone(input.metadata) });
  return { root, ports, service, calls, clients: () => clone(clients), payment };
}
test("opening the package creates no payment; checkout retries reuse one durable intent after restart", async t => {
  const f = checkoutFixture(t); assert.equal(f.calls.length, 0);
  const a = await f.service.checkout("owner"), b = await createStoryCheckout(f.ports).checkout("owner");
  assert.deepEqual(a, b); assert.equal(f.calls.length, 1); assert.equal(a.valor_pago, 19.9); assert.equal(a.quantidade, 10);
  const pack = billing.getBillingStatus(f.clients().owner, { storyPackage: internal.storyPackageFor("owner") }).pacote_stories;
  assert.deepEqual(pack, { id: "i4_stories_10_avulso_v1", title: "10 Stories", amount: 19.9, quantity: 10 });
  assert.equal(a.produto_id, pack.id);
  assert.equal(f.calls[0].metadata.produto_id, pack.id);
  assert.match(f.calls[0].description, /10 Stories/);
  assert.equal(quota.remaining(f.clients().owner), 0);
});
test("internal offer changes only allowed accounts; no allowlist defaults to production behavior", async t => {
  const f = checkoutFixture(t), off = createPromoRollout({ IA4TUBE_WELCOME_ART_ENABLED: "true" });
  assert.equal(off.startWelcomeArt, false);
  assert.equal(off.welcomeArtFor("owner"), false);
  assert.equal(off.storyPackageFor("owner").quantity, 5);
  assert.equal(internal.startWelcomeArt, true);
  assert.equal(internal.welcomeArtFor("owner"), true);
  assert.equal(internal.welcomeArtFor("other"), false);
  const status = billing.getBillingStatus(f.clients().other, { storyPackage: internal.storyPackageFor("other") });
  assert.equal(status.pacote_stories.quantity, 5);
  assert.equal(billing.getBillingStatus(f.clients().other).pacote_stories.quantity, 5);
  const checkout = await f.service.checkout("other");
  assert.equal(checkout.quantidade, 5);
  assert.match(f.calls[0].description, /5 Stories/);
  const active = await f.service.checkout("owner");
  assert.equal(active.quantidade, 10);
  const rolledBack = createStoryCheckout({ ...f.ports, storyPackageFor: off.storyPackageFor });
  assert.equal((await rolledBack.checkout("owner")).quantidade, 10);
  rolledBack.approve(f.payment(f.calls[1]));
  assert.equal(quota.remaining(f.clients().owner), 10);
  assert.equal(quota.remaining(f.clients().other), 0);
});
test("only approved exact payment grants ten, duplicate delivery stays ten and keeps other balances", async t => {
  const f = checkoutFixture(t), before = f.clients(); await f.service.checkout("owner");
  const p = f.payment(f.calls[0]); f.service.approve(p); f.service.approve(p);
  assert.equal(quota.remaining(f.clients().owner), 10); assert.equal(f.clients().owner.artes_mensais_restantes, 10);
  assert.deepEqual(f.clients().other, before.other); assert.equal(f.clients().owner.plano_status, undefined);
});
test("a Pix already pending for five keeps its original offer and cannot be credited as ten", async t => {
  const f = checkoutFixture(t), legacyPackageId = "i4_stories_5_avulso_v1", owner = "owner";
  const id = crypto.randomUUID(), paymentId = "legacy-pix";
  const filename = crypto.createHash("sha256").update(owner).digest("hex") + ".json";
  const result = { ok: true, tipo: "stories_pack_pix", produto_id: legacyPackageId, quantidade: 5,
    purchase_id: id, payment_id: paymentId, valor_pago: 19.9, pix_copia_cola: "fake-legacy-qr" };
  fs.writeFileSync(path.join(f.root, filename), JSON.stringify({ owner,
    intents: [{ id, state: "pending", createdAt: Date.now(), expiresAt: Date.now() + 600000, result }] }));
  assert.deepEqual(await f.service.checkout(owner), result);
  assert.equal(f.calls.length, 0);
  const payment = { id: paymentId, status: "approved", currency_id: "BRL", transaction_amount: 19.90,
    external_reference: `stories_pack_pix|${owner}|${id}`,
    metadata: { tipo: "stories_pack_pix", whatsapp: owner, produto_id: legacyPackageId, purchase_id: id } };
  assert.throws(() => f.service.approve({ ...payment, metadata: { ...payment.metadata, produto_id: quota.STORY_PACKAGE.id } }),
    { code: "story_payment_mismatch" });
  assert.equal(quota.remaining(f.clients().owner), 0);
  assert.equal(f.service.approve(payment).changed, true);
  assert.equal(f.service.approve(payment).changed, false);
  const current = await f.service.checkout(owner);
  assert.equal(current.quantidade, 10);
  assert.equal(f.service.approve(f.payment(f.calls[0])).changed, true);
  assert.equal(quota.remaining(f.clients().owner), 15);
});
for (const [field, value] of [["status", "pending"], ["currency_id", "USD"], ["transaction_amount", 19.8], ["external_reference", "wrong"], ["id", "another-payment"]])
  test(`a mismatched ${field} cannot grant Stories`, async t => {
    const f = checkoutFixture(t); await f.service.checkout("owner"); const p = { ...f.payment(f.calls[0]), [field]: value };
    assert.throws(() => f.service.approve(p)); assert.equal(quota.remaining(f.clients().owner), 0);
  });
test("uncertain provider response retries the same idempotency key and cannot grant credit", async t => {
  const seen = [], f = checkoutFixture(t, { issuePix: async i => { seen.push(i); throw new Error("timeout"); } });
  await assert.rejects(f.service.checkout("owner")); await assert.rejects(createStoryCheckout(f.ports).checkout("owner"));
  assert.deepEqual(seen[0], seen[1]); assert.equal(quota.remaining(f.clients().owner), 0);
});
test("a webhook arriving before checkout completes is not overwritten by the pending response", async t => {
  const f = checkoutFixture(t); f.ports.issuePix = async i => {
    createStoryCheckout(f.ports).approve(f.payment(i));
    return { data: { id: "123456" }, pixCopiaCola: "fake-qr" };
  };
  await createStoryCheckout(f.ports).checkout("owner");
  assert.equal(quota.remaining(f.clients().owner), 10);
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, fs.readdirSync(f.root)[0]), "utf8"));
  assert.equal(stored.intents[0].state, "credited");
});
test("legacy Story balances, exact cancellation refund and additive purchases never reset the monthly plan", () => {
  const c = { plano_status: "none", artes_mensais_restantes: 7 };
  quota.credit(c, "payment-1", "purchase-1", "today", quota.LEGACY_STORY_PACKAGE.id);
  for (let i = 0; i < 5; i++) quota.consume(c, "order-" + i, "today");
  assert.equal(quota.remaining(c), 0); assert.throws(() => quota.consume(c, "sixth", "today"), { code: "billing_required" });
  assert.equal(quota.refund(c, "order-1", "later"), true); assert.equal(quota.refund(c, "order-1", "later"), false);
  assert.equal(quota.remaining(c), 1); quota.credit(c, "payment-2", "purchase-2", "tomorrow");
  assert.equal(quota.remaining(c), 11); assert.equal(c.artes_mensais_restantes, 7);
  billing.getBillingStatus(c, new Date("2099-01-01")); assert.equal(quota.remaining(c), 11);
});
function calendarFixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-admission-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = { ativo: true, arte_gratis_usada: true, plano_status: "none", artes_mensais_total: 0, artes_mensais_restantes: 0,
    artes_avulsas_restantes: 0, ...extra };
  quota.credit(client, "synthetic-payment", "synthetic-purchase", "today");
  let clients = { owner: client, other: { untouched: true } };
  const ports = { dataDir: root, planningDir: path.join(root, "planning"), ordersDir: path.join(root, "orders"),
    secret: "synthetic-story-package-secret-not-a-credential", readClients: () => clone(clients), writeClients: v => { clients = clone(v); },
    prepareCalendarRequest: async () => null, admissionEnabled: true,
    observeConnection: async () => ({ provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "123456789012345" }) };
  const service = createEditCalendarService(ports); t.after(() => service.close());
  const claims = { whatsapp: "owner", sub: "owner", company_id: "owner", token_version: 2, iss: "ia4tube-api", aud: "ia4tube-client", jti: crypto.randomUUID() };
  async function request(destination = "story", mediaKind = "image") {
    const c = await service.createContext(claims, { requestId: crypto.randomUUID(), date: new Date(Date.now() + 86400000).toISOString().slice(0,10), time: "18:00", destination, caption: "Synthetic" });
    return { schemaVersion: 1, ticket: c.ticket, editOrderId: admissionOrderId(c.ticket), requestHash: hash(crypto.randomUUID()), mediaKind,
      title: "Synthetic image", caption: "Synthetic", durationSeconds: mediaKind === "image" ? null : 10,
      selection: { modelId: crypto.randomUUID(), modelVersion: 1, sourceDigest: hash("synthetic-art") }, quantity: 1 };
  }
  return { service, request, claims, clients: () => clone(clients) };
}
test("the real existing admission reserves ten Stories once, rejects eleventh and refunds one cancelled intent", async t => {
  const f = calendarFixture(t), reqs = [];
  for (let i = 0; i < 10; i++) { const r = await f.request(); reqs.push(r); await f.service.admit(r); await f.service.admit(r); }
  assert.equal(quota.remaining(f.clients().owner), 0);
  await assert.rejects(f.service.admit(await f.request()), { code: "billing_required" });
  const r = reqs[0], cancel = { schemaVersion: 1, ticket: r.ticket, editOrderId: r.editOrderId, requestHash: r.requestHash, reason: "upload_unavailable" };
  await f.service.cancelAdmission(cancel); await f.service.cancelAdmission(cancel);
  assert.equal(quota.remaining(f.clients().owner), 1); assert.deepEqual(f.clients().other, { untouched: true });
});
for (const [destination, kind] of [["feed", "image"], ["both", "image"], ["story", "video"]])
  test(`restricted Story credits cannot fund ${destination}/${kind}`, async t => {
    const f = calendarFixture(t), r = await f.request(destination, kind);
    await assert.rejects(f.service.admit(r), { code: "billing_required" }); assert.equal(quota.remaining(f.clients().owner), 10);
  });
test("Story-only image binds through the existing production path without another debit", async t => {
  const f = calendarFixture(t), r = await f.request(); await f.service.admit(r);
  const result = f.service.bind({ ticket: r.ticket, editOrderId: r.editOrderId, title: r.title, caption: r.caption,
    mediaKind: "image", durationSeconds: null, inputHash: hash("synthetic-production") });
  assert.ok(result); assert.equal(quota.remaining(f.clients().owner), 9);
});
test("a monthly subscriber spends the restricted Story first and keeps all ten monthly images", async t => {
  const f = calendarFixture(t, { plano_status: "active", plano_renova_em: "2099-01-01", artes_mensais_total: 10, artes_mensais_restantes: 10 });
  await f.service.admit(await f.request());
  assert.equal(quota.remaining(f.clients().owner), 9); assert.equal(f.clients().owner.artes_mensais_restantes, 10);
  await f.service.admit(await f.request("feed"));
  assert.equal(quota.remaining(f.clients().owner), 9); assert.equal(f.clients().owner.artes_mensais_restantes, 9);
});
test("observing Story availability preserves the exact old five-field Android contract and never writes", async t => {
  const f = calendarFixture(t), before = f.clients(), result = await f.service.availability(f.claims);
  assert.deepEqual(Object.keys(result.availability).sort(), ["schemaVersion", "canImage", "canVideo", "observedAt", "validUntil"].sort());
  assert.equal(result.availability.canImage, true); assert.equal(result.availability.canVideo, false); assert.deepEqual(f.clients(), before);
});
test("a blocked account is denied before saving an intent or calling the Pix provider", async t => {
  const f = checkoutFixture(t, { assertAllowed: () => { throw Object.assign(new Error("blocked"), { code: "pix_account_blocked" }); } });
  await assert.rejects(f.service.checkout("owner"), { code: "pix_account_blocked" });
  assert.equal(f.calls.length, 0); assert.equal(fs.readdirSync(f.root).length, 0);
});
test("concurrent checkout gestures cannot create two Pix intents", async t => {
  let complete, count = 0;
  const f = checkoutFixture(t, { issuePix: async () => { count++; return new Promise(resolve => { complete = resolve; }); } });
  const first = f.service.checkout("owner");
  await assert.rejects(f.service.checkout("owner"), { code: "story_checkout_busy" });
  complete({ data: { id: "one-payment" }, pixCopiaCola: "fake" }); await first;
  assert.equal(count, 1);
});
