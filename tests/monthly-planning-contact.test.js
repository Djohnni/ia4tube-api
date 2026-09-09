"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const planningService = require("../src/company-monthly-planning/planning.service");
const orderStorage = require("../src/orders/order.storage");

const owners = ["synthetic_contact_owner", "5511999999901"];

function fixture(t, owner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-contact-synthetic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cliente = {
    whatsapp: owner,
    nome_empresa: "Empresa sintetica",
    ramo: "Marketing visual",
    plano_status: "active",
    plano_renova_em: "2099-01-01",
    plano_ciclo: "2099-01",
    artes_mensais_total: 20,
    artes_mensais_restantes: 20,
    artes_avulsas_restantes: 0
  };
  const request = {
    baseDir: path.join(root, "planning"),
    cliente,
    whatsapp: owner,
    body: { quantidade_reservada: 1, nome_empresa: cliente.nome_empresa, ramo: cliente.ramo }
  };
  return { root, cliente, request };
}

function childOrder(owner, profile = {}) {
  return planningService._private.buildChildOrder({
    planning: { planejamento_id: "synthetic-plan", whatsapp: owner, profile },
    item: { ordem: 1, objetivo: "Divulgar servico", sem_imagem: true },
    itemId: "synthetic-item",
    pedidoId: "synthetic-order",
    mesAtual: "2099-01",
    copiedAssets: { fotos: [], logo: "" }
  });
}

function assertContact(order, expected) {
  assert.equal(order.whatsapp_contato, expected);
  assert.equal(order.fields.whatsapp, expected);
  assert.equal(order.legacy.whatsapp_contato, expected);
  const cta = expected ? "Chame no WhatsApp" : "Entre em contato";
  assert.equal(order.cta, cta);
  assert.equal(order.fields.cta, cta);
  assert.equal(order.legacy.cta, cta);
}

for (const owner of owners) {
  for (const contact of [undefined, null, "", "   "]) {
    test(`optional contact ${JSON.stringify(contact)} never uses account ${owner}`, t => {
      const { cliente, request } = fixture(t, owner);
      if (contact !== undefined) request.body.whatsapp = contact;
      const created = planningService.createRequest(request);
      assert.equal(created.profile.whatsapp, "");
      assert.equal(created.whatsapp, owner);
      assert.equal(cliente.whatsapp, owner);
      const stored = planningService.findPlanningById({
        baseDir: request.baseDir, whatsapp: owner, planningId: created.id
      });
      assert.equal(stored.profile.whatsapp, "");
      assert.equal(stored.whatsapp, owner);
      assertContact(childOrder(owner, stored.profile), "");
    });
  }

  for (const contact of ["", "+55 (21) 98888-7700"]) {
    test(`three generated children keep contact ${JSON.stringify(contact)} separate from owner ${owner}`, t => {
      const { root, cliente, request } = fixture(t, owner);
      request.body.whatsapp = `  ${contact}  `;
      request.body.quantidade_reservada = 3;
      const created = planningService.createRequest(request);
      assert.equal(created.profile.whatsapp, contact);
      const pedidosDir = path.join(root, "orders");
      planningService.savePlanResult({
        baseDir: request.baseDir,
        planningId: created.id,
        pedidosDir,
        cliente,
        payload: { postagens: [1, 2, 3].map(ordem => ({ ordem, objetivo: "Divulgar servico" })) }
      });
      const children = orderStorage.listPedidoBasesByWhatsapp(pedidosDir, owner);
      assert.equal(children.length, 3);
      for (const { pedido } of children) {
        assert.equal(pedido.whatsapp, owner);
        assertContact(pedido, contact);
      }
      assert.equal(cliente.whatsapp, owner);
      if (contact) assert.deepEqual(orderStorage.listPedidoBasesByWhatsapp(pedidosDir, contact), []);
    });
  }

  for (const profile of [{}, { whatsapp: "" }, { whatsapp: "synthetic_5511999999901" }]) {
    test(`child revalidates stored profile ${JSON.stringify(profile)} without using ${owner}`, () => {
      const child = childOrder(owner, profile);
      assert.equal(child.whatsapp, owner);
      assertContact(child, "");
    });
  }
}

for (const contact of ["11988887700", "(11) 3888-7700", "+1 202-555-0198", "5511999999901"]) {
  test(`explicit phone ${contact} remains available for artwork`, t => {
    const { request } = fixture(t, owners[1]);
    request.body.whatsapp = contact;
    const created = planningService.createRequest(request);
    assert.equal(created.profile.whatsapp, contact);
    assertContact(childOrder(owners[1], created.profile), contact);
  });
}

for (const contact of [
  "synthetic_contact_owner", "synthetic_5511999999901", "119999999", "5511999999901000x",
  "1234567890123456", "00000000000", "+", "++5511999999901", "https://wa.me/5511999999901",
  "5511999999901\nWhatsApp", 5511999999901, ["5511999999901"], { number: "5511999999901" }
]) {
  test(`invalid explicit contact ${JSON.stringify(contact)} fails before reservation or persistence`, t => {
    const { cliente, request } = fixture(t, owners[0]);
    request.body.whatsapp = contact;
    const before = structuredClone(cliente);
    let authorizationCalls = 0;
    request.calendarAuthorizationFactory = () => { authorizationCalls++; return null; };
    assert.throws(() => planningService.createRequest(request), error =>
      error.statusCode === 400 && error.code === "monthly_planning_invalid_whatsapp_contact");
    assert.deepEqual(cliente, before);
    assert.equal(authorizationCalls, 0);
    assert.equal(fs.existsSync(request.baseDir), false);
    assertContact(childOrder(owners[0], { whatsapp: contact }), "");
  });
}
