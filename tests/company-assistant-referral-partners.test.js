"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createReferralPartnerDirectory } = require("../src/company-assistant/referral-partners");

const DEFAULT = { name: "Los Hermanos", handle: "@los_hermanos_ls" };

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "i4-referral-partners-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "company_assistant_v1");
  function open(initialPartners = [DEFAULT]) {
    return createReferralPartnerDirectory({ root, initialPartners });
  }
  return { root, file: path.join(root, "referral-partners.json"), open };
}

test("an absent file serves a fresh default copy and saved additions survive a new directory instance in order", t => {
  const { file, open } = fixture(t);
  const directory = open();
  const firstList = directory.list();
  assert.deepEqual(firstList, [DEFAULT]);
  assert.equal(fs.existsSync(file), false);
  firstList[0].name = "Mutação do chamador";
  assert.deepEqual(directory.list(), [DEFAULT]);

  const partner = directory.add({ name: "  Cafe\u0301  da  Ana  ", handle: " Cafe.ANA_1 " });
  const other = directory.add({ name: "Café da Ana", handle: "@outro_cafe" });
  assert.deepEqual(partner, { name: "Café da Ana", handle: "@cafe.ana_1" });
  assert.deepEqual(open([]).list(), [DEFAULT, partner, other]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schema: 1, partners: [DEFAULT, partner, other] });
});

test("successive synchronous additions from separate instances cannot register the same handle", t => {
  const { file, open } = fixture(t);
  const first = open();
  const second = open();
  assert.throws(() => second.add({ name: "Mesmo perfil", handle: "LOS_HERMANOS_LS" }), { code: "referral_partner_exists" });
  assert.equal(fs.existsSync(file), false);
  first.add({ name: "Outro parceiro", handle: "@Perfil_Novo" });
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => second.add({ name: "Mesmo perfil novo", handle: "PERFIL_NOVO" }), { code: "referral_partner_exists" });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(second.list().length, 2);
});

test("invalid names and handles are refused before persisting and a 30-character handle is accepted", t => {
  const { file, open } = fixture(t);
  const directory = open();
  const invalid = [null, {}, { name: 100, handle: "perfil" }, { name: "  ", handle: "perfil" },
    { name: "Parceiro\nnovo", handle: "perfil" }, { name: "Parceiro\u2028novo", handle: "perfil" },
    { name: "Parceiro\u200fnovo", handle: "perfil" }, { name: "a".repeat(101), handle: "perfil" },
    { name: "Parceiro", handle: "@" }, { name: "Parceiro", handle: "@@perfil" },
    { name: "Parceiro", handle: "perfil\n" }, { name: "Parceiro", handle: "per fil" },
    { name: "Parceiro", handle: "perfil.é" }, { name: "Parceiro", handle: "a".repeat(31) },
    { name: "Parceiro", handle: "https://www.instagram.com/perfil" }];
  for (const partner of invalid) assert.throws(() => directory.add(partner), { code: "referral_partner_invalid" });
  assert.equal(fs.existsSync(file), false);
  assert.equal(directory.add({ name: "Parceiro", handle: "@" + "a".repeat(30) }).handle, "@" + "a".repeat(30));
});

test("a malformed or conflicting persisted list is not silently replaced with defaults", t => {
  const { file, root, open } = fixture(t);
  fs.mkdirSync(root);
  const directory = open();
  const badContents = ["{", JSON.stringify({ schema: 2, partners: [] }), JSON.stringify({ schema: 1, partners: {} }),
    JSON.stringify({ schema: 1, partners: [{}] }),
    JSON.stringify({ schema: 1, partners: [DEFAULT, { ...DEFAULT, handle: "Los_Hermanos_LS" }] })];
  for (const content of badContents) {
    fs.writeFileSync(file, content);
    assert.throws(() => directory.list(), { code: "referral_partner_storage_invalid" });
    assert.throws(() => directory.add({ name: "Parceiro novo", handle: "@parceiro_novo" }), { code: "referral_partner_storage_invalid" });
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
  fs.writeFileSync(file, JSON.stringify({ schema: 1, partners: [] }));
  assert.deepEqual(directory.list(), []);
});
