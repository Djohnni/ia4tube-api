"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const quota = require("./story-quota");
function createStoryCheckout({ root, readClients, writeClients, issuePix, assertAllowed, clock = Date.now,
  storyPackageFor = () => quota.LEGACY_STORY_PACKAGE }) {
  const busy = new Set();
  const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
  const file = owner => path.join(root, crypto.createHash("sha256").update(String(owner)).digest("hex") + ".json");
  function read(owner) { const f = file(owner); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { owner, intents: [] }; }
  function write(owner, value) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const f = file(owner), tmp = f + "." + crypto.randomUUID() + ".tmp";
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
  }
  function intentPackage(intent) {
    // Journals written before product versioning can only refer to the original five-credit offer.
    return quota.getStoryPackage(intent.productId ?? quota.LEGACY_STORY_PACKAGE.id);
  }
  async function checkout(owner) {
    assertAllowed(owner);
    if (!readClients()[owner]) fail("client_not_found", 404);
    if (busy.has(owner)) fail("story_checkout_busy");
    busy.add(owner);
    try {
      const journal = read(owner);
      let intent = journal.intents.at(-1);
      if (!intent || intent.state === "credited" || (intent.result && intent.expiresAt && intent.expiresAt + 900000 < clock())) {
        const pack = quota.getStoryPackage(storyPackageFor(owner)?.id);
        if (!pack) fail("story_checkout_reconciliation_required", 503);
        intent = { id: crypto.randomUUID(), state: "created", createdAt: clock(), productId: pack.id };
        journal.intents.push(intent); write(owner, journal);
      }
      if (!intent.result) {
        const pack = intentPackage(intent);
        if (!pack) fail("story_checkout_reconciliation_required", 503);
        const result = await issuePix({ amount: pack.amount, description: `iA4tube - ${pack.title} (pacote avulso)`,
          payerKey: owner, externalReference: `stories_pack_pix|${owner}|${intent.id}`,
          metadata: { tipo: "stories_pack_pix", whatsapp: owner, produto_id: pack.id, purchase_id: intent.id },
          idempotencyKey: `stories_${intent.id}` });
        // A fast webhook can commit while the provider's response is still in flight.
        const latest = read(owner), stored = latest.intents.find(i => i.id === intent.id);
        if (!stored || (stored.paymentId && stored.paymentId !== String(result.data.id))) fail("story_checkout_reconciliation_required", 503);
        intent = stored;
        intent.result = { ok: true, tipo: "stories_pack_pix", produto_id: pack.id, quantidade: pack.quantity,
          purchase_id: intent.id, payment_id: String(result.data.id), valor_pago: pack.amount,
          pix_copia_cola: result.pixCopiaCola || "", qr_code_base64: result.qrCodeBase64 || "", ticket_url: result.ticketUrl || "" };
        intent.expiresAt = Date.parse(result.data.date_of_expiration || "") || null;
        if (intent.state !== "credited") intent.state = "pending";
        write(owner, latest);
      }
      return intent.result;
    } finally { busy.delete(owner); }
  }
  function approve(payment) {
    const m = payment.metadata || {}, owner = m.whatsapp;
    const pack = quota.getStoryPackage(m.produto_id);
    if (payment.status !== "approved" || payment.currency_id !== "BRL" ||
        !pack || Math.round(Number(payment.transaction_amount) * 100) !== Math.round(pack.amount * 100) ||
        typeof owner !== "string" || !m.purchase_id ||
        payment.external_reference !== `stories_pack_pix|${owner}|${m.purchase_id}`) fail("story_payment_invalid", 400);
    const journal = read(owner), intent = journal.intents.find(i => i.id === m.purchase_id);
    if (!intent || intentPackage(intent)?.id !== pack.id ||
        (intent.result && intent.result.payment_id !== String(payment.id))) fail("story_payment_mismatch");
    const clients = readClients(), client = clients[owner];
    if (!client) fail("client_not_found", 404);
    // No await between the fresh account read and its existing synchronous commit.
    const changed = quota.credit(client, String(payment.id), intent.id, new Date(clock()).toISOString(), pack.id);
    if (changed) writeClients(clients);
    intent.state = "credited"; intent.paymentId = String(payment.id); write(owner, journal);
    return { owner, changed };
  }
  return { checkout, approve };
}
module.exports = { createStoryCheckout };
