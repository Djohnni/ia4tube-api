"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { buildReferralReport } = require("../src/company-assistant/referral-report");

const GOOGLE = "google_synthetic_account";
const WHATSAPP = "5511999995678";
const COURTESY = "courtesy.example";
const PAID = "2030-02-01T15:00:00.000Z";
const RENEWAL = "2030-03-01T15:00:00.000Z";
const REFERRAL = "2030-01-31T15:00:00.000Z";
const IMAGES = "i4_imagens_10_v1";
const COMBO = "i4_combo_20i_15v_v1";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const paidPlan = (owner, planId, status = "approved") => ({
  tipo: "plano_pix", status, whatsapp: owner, plan_id: planId, secret: "data-not-for-display"
});
const receipt = (planId, paidAt, status = "activated_from_payment_date") => ({ schemaVersion: 1, planId, paidAt, status });

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "i4-referral-report-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const directory = path.join(dataDir, "company_assistant_v1", "referrals");
  async function referral(owner, { name = "Parceiro de teste", handle = "@parceiro_teste", at = REFERRAL, outcome = "selected" } = {}) {
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, sha256("assistant-v1\0" + owner) + ".json");
    await fs.writeFile(file, JSON.stringify({ outcome, attribution: { name, handle, at: Date.parse(at) },
      messages: [{ text: "conteúdo privado do chat" }], requests: { id: "controle-privado" } }));
    return file;
  }
  return { dataDir, directory, referral };
}

test("an empty or missing referral directory produces an empty report without opening account or billing records", async t => {
  const { dataDir, directory } = await fixture(t);
  const report = () => buildReferralReport({ dataDir,
    readClients: () => assert.fail("No referrals to match"), readPayments: () => assert.fail("No purchases to match") });
  const expected = { ok: true, totals: { referrals: 0, customersWithPurchase: 0 }, partners: [] };
  assert.deepEqual(await report(), expected);
  await fs.mkdir(directory, { recursive: true });
  assert.deepEqual(await report(), expected);
});

test("approved monthly purchases join by owner and receipt, count customers distinctly and project only report fields", async t => {
  const { dataDir, referral } = await fixture(t);
  const file = await referral(GOOGLE, { handle: "@Parceiro_Teste" });
  const before = await fs.readFile(file, "utf8");
  await referral(WHATSAPP, { at: PAID });
  await referral(COURTESY, { name: "Outro parceiro", handle: "@outro_parceiro" });
  await referral("skipped", { outcome: "skipped" });
  await referral("deleted_account");

  const clients = {
    [GOOGLE]: { login_tipo: "google", nome_time: "Café do Bairro", email: "fake-account@example.invalid", google_id: "synthetic_account",
      senha_hash: "hash-secret", plano_cotas_pagamentos: {
        [sha256("test-plan-1")]: receipt(IMAGES, PAID),
        [sha256("test-plan-2")]: receipt(COMBO, RENEWAL, "scheduled_next_cycle")
      } },
    [WHATSAPP]: { nome_time: "Contato +55 (11) 99999-5678", senha_hash: "phone-secret", plano_cotas_pagamentos: {
      [sha256("test-phone-plan")]: receipt(COMBO, PAID)
    } },
    [COURTESY]: { nome_time: "name@example.invalid", plano_atual: COMBO, plano_status: "active", plano_preco: 259,
      courtesy_test_operation: { chargedAmount: 0, paymentCreated: false } },
    skipped: { nome_time: "Cliente que pulou" }
  };
  const payments = {
    "test-plan-1": paidPlan(GOOGLE, IMAGES),
    "test-plan-2": paidPlan(GOOGLE, COMBO),
    "test-phone-plan": paidPlan(WHATSAPP, COMBO),
    "test-courtesy-pending": paidPlan(COURTESY, COMBO, "pending"),
    "test-courtesy-approved-without-receipt": paidPlan(COURTESY, COMBO),
    "test-skipped": paidPlan("skipped", COMBO),
    "test-deleted": paidPlan("deleted_account", COMBO)
  };
  let clientReads = 0;
  let paymentReads = 0;
  const result = await buildReferralReport({ dataDir,
    readClients: () => { clientReads++; return clients; }, readPayments: () => { paymentReads++; return payments; } });
  assert.deepEqual(result, {
    ok: true, totals: { referrals: 3, customersWithPurchase: 2 },
    partners: [
      { name: "Outro parceiro", handle: "@outro_parceiro", referrals: [
        { name: "Cliente", loginLabel: "WhatsApp", referredAt: REFERRAL, purchases: [] }
      ] },
      { name: "Parceiro de teste", handle: "@parceiro_teste", referrals: [
        { name: "Cliente", loginLabel: "WhatsApp · final 5678", referredAt: PAID,
          purchases: [{ planName: "Empresarial", paidAt: PAID }] },
        { name: "Café do Bairro", loginLabel: "Google", referredAt: REFERRAL,
          purchases: [{ planName: "Empresarial", paidAt: RENEWAL }, { planName: "Imagens", paidAt: PAID }] }
      ] }
    ]
  });
  assert.equal(clientReads, 1);
  assert.equal(paymentReads, 1);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("a journal row alone cannot count a purchase, and approvals before the indication or for other products are excluded", async t => {
  const { dataDir, referral } = await fixture(t);
  await referral(GOOGLE);
  const clients = {
    [GOOGLE]: { nome_time: GOOGLE, plano_cotas_pagamentos: {
      [sha256("earlier")]: receipt(COMBO, "2030-01-30T15:00:00.000Z"),
      [sha256("pending")]: receipt(COMBO, PAID),
      [sha256("cancelled")]: receipt(COMBO, PAID),
      [sha256("stories")]: receipt(COMBO, PAID),
      [sha256("wrong-plan")]: receipt(COMBO, PAID),
      [sha256("wrong-status")]: receipt(COMBO, PAID, "courtesy"),
      [sha256("invalid-date")]: receipt(COMBO, "inválida"),
      [sha256("legacy")]: receipt("i4_empresarial", PAID)
    } }
  };
  const payments = {
    earlier: { ...paidPlan(GOOGLE, COMBO), criado_em: PAID },
    pending: paidPlan(GOOGLE, COMBO, "pending"),
    cancelled: paidPlan(GOOGLE, COMBO, "cancelled"),
    stories: { ...paidPlan(GOOGLE, COMBO), tipo: "stories_pack_pix" },
    "wrong-plan": paidPlan(GOOGLE, IMAGES),
    "wrong-status": paidPlan(GOOGLE, COMBO),
    "invalid-date": paidPlan(GOOGLE, COMBO),
    legacy: paidPlan(GOOGLE, "i4_empresarial"),
    "without-receipt": { ...paidPlan(GOOGLE, COMBO), criado_em: PAID }
  };
  const result = await buildReferralReport({ dataDir, readClients: () => clients, readPayments: () => payments });
  assert.deepEqual(result.totals, { referrals: 1, customersWithPurchase: 0 });
  assert.deepEqual(result.partners[0].referrals, [{ name: "Cliente", loginLabel: "Google", referredAt: REFERRAL, purchases: [] }]);
});
