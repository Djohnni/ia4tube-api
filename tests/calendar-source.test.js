"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const planning = require("../src/company-monthly-planning/planning.service");
const { createCalendarSource } = require("../src/social/calendar/source");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const { consentPath } = require("../src/social/calendar/model");
test("real existing creation, plan, child artwork and calendar feed the bridge without exporting the consent", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-calendar-source-synthetic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseDir = path.join(root, "planning"), pedidosDir = path.join(root, "orders"); fs.mkdirSync(pedidosDir);
  const owner = "5511999999901", client = { whatsapp: owner, nome_empresa: "Synthetic", ramo: "Loja",
    plano_status: "active", plano_renova_em: "2099-01-01", plano_ciclo: "2099-01", artes_mensais_total: 20,
    artes_mensais_restantes: 20, artes_avulsas_restantes: 0 };
  const companyId = crypto.randomUUID(), userId = crypto.randomUUID();
  const grants = createCalendarGrants(crypto.randomBytes(32)); t.after(() => grants.close());
  const request = planning.createRequest({ baseDir, cliente: client, whatsapp: owner,
    body: { quantidade_reservada: 1, nome_empresa: "Synthetic", ramo: "Loja", orientacoes_fotos: JSON.stringify([
      { slot_id: "slot1", ordem: 1, tem_arquivo: false, sem_imagem: true, objetivo: "Divulgar", escrita_imagem: "Arte sintética" }]) },
    calendarAuthorizationFactory: ({ planningId, quantity }) => grants.issue({ planningId, quantity, companyId, userId, revision: 1,
      binding: { connectionId: crypto.randomUUID(), externalId: "12345678901234", connectionRevision: 1 } }) });
  assert.equal(Object.hasOwn(request, "calendar_auto_authorization"), false);
  const stored = planning.findPlanningById({ baseDir, whatsapp: owner, planningId: request.id });
  assert.equal(fs.existsSync(path.join(stored.base_path, "calendar-consent.json")), false);
  assert.ok(fs.existsSync(consentPath(baseDir, owner, request.id)));
  planning.savePlanResult({ baseDir, planningId: request.id, pedidosDir, cliente: client, payload: {
    postagens: [{ ordem: 1, tema: "Arte sintética", objetivo: "Divulgar", data_sugerida: "2099-01-02", horario_sugerido: "12:00" }] } });
  const source = createCalendarSource({ dataDir: root, planningDir: baseDir, ordersDir: pedidosDir });
  const pending = source.list(owner); assert.equal(pending.length, 1); assert.equal(pending[0].imageReady, false);
  assert.equal(pending[0].destination, "feed"); assert.equal(pending[0].layout, "safe_master_v1");
  const allOrders = require("../src/orders/order.storage").listPedidoBasesByWhatsapp(pedidosDir, owner);
  const child = allOrders.find(entry => entry.id === pending[0].orderId).pedido;
  assert.equal(child.planejamento_mensal.instagram_layout, "safe_master_v1");
  assert.ok(grants.verify(pending[0].authorizationEnvelope, companyId, userId));
  const image = await require("sharp")({ create: { width: 200, height: 200, channels: 3, background: "white" } }).png().toBuffer();
  const resultPath = path.join(root, "result.png"); fs.writeFileSync(resultPath, image);
  planning.savePlanningArtResult({ pedidosDir, pedidoId: pending[0].orderId, resultadoPath: resultPath, descricaoInstagram: "Legenda final gerada" });
  const ready = source.list(owner)[0]; assert.equal(ready.imageReady, true); assert.equal(ready.caption, "Legenda final gerada");
  assert.deepEqual(await source.load(owner, ready), image);
  let reminders = 0;
  const notifications = await planning.processDueNotifications({ baseDir, pedidosDir, clientes: { [owner]: client },
    now: new Date("2100-01-01T00:00:00Z"), sendNotification: async () => { reminders++; return { ok: true }; } });
  assert.equal(reminders, 0, "automatic orders never ask for a second, manual publication");
  assert.equal(notifications.skipped, 1);
  const receipt = consentPath(baseDir, owner, request.id);
  fs.renameSync(receipt, `${receipt}.synthetic-disabled`);
  try {
    const manual = await planning.processDueNotifications({ baseDir, pedidosDir, clientes: { [owner]: client },
      now: new Date("2100-01-01T00:00:00Z"), sendNotification: async () => { reminders++; return { ok: true }; } });
    assert.equal(reminders, 1, "legacy manual scheduling still has its existing reminder");
    assert.equal(manual.sent, 1);
  } finally { fs.renameSync(`${receipt}.synthetic-disabled`, receipt); }
  assert.deepEqual(source.list("5511999999902"), []);
  planning.hideClientPlanningCalendarItem({ baseDir, whatsapp: owner, itemKey: ready.key });
  assert.deepEqual(source.list(owner), []);
  assert.deepEqual(await source.load(owner, ready), image, "hiding schedule preserves the original art");
});
