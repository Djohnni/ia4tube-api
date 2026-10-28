"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const planning = require("../src/company-monthly-planning/planning.service");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { createCalendarSource } = require("../src/social/calendar/source");

function fixture(t, now = "2026-10-28T22:00:00Z") {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-edit-date-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = "synthetic-date-owner", planningDir = path.join(root, "planning"), ordersDir = path.join(root, "orders");
  fs.mkdirSync(ordersDir);
  let clients = { [owner]: { whatsapp: owner, ativo: true, nome_empresa: "Loja sintética", ramo: "Loja", plano_status: "active",
    plano_renova_em: "2099-01-01", plano_ciclo: "2026-10", artes_mensais_total: 20, artes_mensais_restantes: 20, artes_avulsas_restantes: 0 } };
  const service = createEditCalendarService({ dataDir: root, planningDir, ordersDir, secret: "synthetic-schedule-secret-".repeat(3),
    readClients: () => structuredClone(clients), writeClients: value => { clients = value; }, prepareCalendarRequest: async () => null });
  t.after(() => service.close());
  const source = createCalendarSource({ dataDir: root, planningDir, ordersDir });
  const plan = id => planning.findPlanningById({ baseDir: planningDir, whatsapp: owner, planningId: id });
  const save = (id, posts) => planning.savePlanResult({ baseDir: planningDir, planningId: id, pedidosDir: ordersDir,
    cliente: clients[owner], payload: { postagens: posts } });
  function create(externalEdit = null) {
    return planning.createRequest({ baseDir: planningDir, cliente: clients[owner], whatsapp: owner,
      body: { quantidade_reservada: 1 }, externalEdit });
  }
  function seedOccupiedDates() {
    return Array.from({ length: 5 }, (_, index) => {
      const created = create();
      return save(created.id, [{ ordem: 1, tema: `Existente ${index}`, data_sugerida: "2026-10-29", horario_sugerido: "09:00" }])
        .plano_mensal.postagens[0].data_sugerida;
    });
  }
  async function context(date, time) {
    return service.createContext({ whatsapp: owner }, { requestId: crypto.randomUUID(), date, time, destination: "reel", caption: "Legenda exata" });
  }
  const bindBody = ticket => ({ ticket, editOrderId: crypto.randomUUID(), title: "Modelo sintético", caption: "Legenda exata",
    durationSeconds: 10, inputHash: "a".repeat(64) });
  return { root, owner, service, source, planningDir, ordersDir, plan, save, create, seedOccupiedDates, context, bindBody,
    client: () => clients[owner] };
}

test("Edit keeps the selected same-day 20:10 despite five occupied following days; a completed retry cannot charge again", async t => {
  const f = fixture(t);
  assert.deepEqual(f.seedOccupiedDates(), ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  const before = structuredClone(f.client()), context = await f.context("2026-10-28", "20:10"), body = f.bindBody(context.ticket);
  const result = f.service.bind(body), post = f.plan(result.planningId).plano_mensal.postagens[0];
  assert.equal(post.data_sugerida, "2026-10-28"); assert.equal(post.horario_sugerido, "20:10");
  assert.doesNotMatch(post.criterio_agendamento || "", /distribuir/);
  const child = planning.findPlanningArtOrder({ pedidosDir: f.ordersDir, pedidoId: result.pedidoId });
  assert.equal(child.pedido.data_sugerida, "2026-10-28"); assert.equal(child.pedido.horario_sugerido, "20:10");
  const item = f.source.list(f.owner).find(value => value.orderId === result.pedidoId);
  assert.equal(item.date, "2026-10-28"); assert.equal(item.time, "20:10");
  assert.equal(f.client().artes_mensais_restantes, before.artes_mensais_restantes - 1);
  const charged = structuredClone(f.client()); t.mock.timers.tick(8 * 86400000);
  assert.deepEqual(f.service.bind(body), result); assert.deepEqual(f.client(), charged);
  assert.equal(f.source.list(f.owner).filter(value => value.orderId === result.pedidoId).length, 1);
});

for (const { date, time } of [{ date: "2026-10-28", time: "23:59" }, { date: "2026-10-29", time: "00:01" }]) {
  test(`Edit preserves the Brazilian midnight boundary ${date} ${time} outside monthly suggested hours`, async t => {
    const f = fixture(t, "2026-10-29T02:58:00Z"), context = await f.context(date, time);
    const result = f.service.bind(f.bindBody(context.ticket)), item = f.source.list(f.owner).find(value => value.orderId === result.pedidoId);
    assert.equal(item.date, date); assert.equal(item.time, time);
  });
}

test("a selection valid when made stays exact if Edit production/allocation finishes after that time", async t => {
  const f = fixture(t), context = await f.context("2026-10-28", "20:10");
  t.mock.timers.tick(3 * 3600000);
  const result = f.service.bind(f.bindBody(context.ticket)), item = f.source.list(f.owner).find(value => value.orderId === result.pedidoId);
  assert.equal(item.date, "2026-10-28"); assert.equal(item.time, "20:10");
});

test("ordinary monthly planning retains its existing next-empty-day distribution", t => {
  const f = fixture(t); f.seedOccupiedDates();
  const created = f.create(), saved = f.save(created.id, [{ ordem: 1, tema: "Mensal comum", data_sugerida: "2026-10-28", horario_sugerido: "20:10" }]);
  const post = saved.plano_mensal.postagens[0];
  assert.equal(post.data_sugerida, "2026-11-03"); assert.equal(post.horario_sugerido, "20:10");
  assert.match(post.criterio_agendamento, /dia_livre_distribuido/);
});

for (const schedule of [{ data_sugerida: "2026-02-30", horario_sugerido: "20:10" },
  { data_sugerida: "2026-10-28", horario_sugerido: "24:00" }, { data_sugerida: "2026-10-28", horario_sugerido: "20:60" },
  { data_sugerida: "28/10/2026", horario_sugerido: "20:10" }, { data_sugerida: "2026-10-28" }]) {
  test(`Edit rejects malformed selected schedule ${JSON.stringify(schedule)} before writing its result or creating a child`, t => {
    const f = fixture(t), created = f.create({ kind: "edit_calendar_v1", contextId: crypto.randomUUID(), editOrderId: crypto.randomUUID(), inputHash: "b".repeat(64) });
    const before = f.plan(created.id), client = structuredClone(f.client()), files = [before.solicitacao_path, path.join(before.base_path, "plano_mensal.json")];
    const snapshots = files.map(file => fs.readFileSync(file));
    assert.throws(() => f.save(created.id, [{ ordem: 1, tema: "Invalido", ...schedule }]), { code: "edit_calendar_schedule_invalid", statusCode: 400 });
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), snapshots[index]));
    assert.deepEqual(f.client(), client); assert.deepEqual(f.source.list(f.owner), []);
  });
}

test("a validated Edit registration still rejects two postings before creating either child", t => {
  const f = fixture(t), created = f.create({ kind: "edit_calendar_v1", contextId: crypto.randomUUID(), editOrderId: crypto.randomUUID(), inputHash: "c".repeat(64) });
  const post = { tema: "Video", data_sugerida: "2026-10-28", horario_sugerido: "20:10" }, client = structuredClone(f.client());
  assert.throws(() => f.save(created.id, [{ ...post, ordem: 1 }, { ...post, ordem: 2 }]), { code: "edit_calendar_registration_invalid" });
  assert.deepEqual(f.client(), client); assert.deepEqual(f.source.list(f.owner), []);
});

test("a malformed stored Edit marker cannot bypass ordinary monthly scheduling", t => {
  const f = fixture(t), created = f.create(), stored = f.plan(created.id), value = JSON.parse(fs.readFileSync(stored.solicitacao_path, "utf8"));
  value.edit_calendar = { kind: "edit_calendar_v1", contextId: "not-a-uuid", editOrderId: crypto.randomUUID(), inputHash: "d".repeat(64) };
  fs.writeFileSync(stored.solicitacao_path, JSON.stringify(value));
  assert.throws(() => f.save(created.id, [{ tema: "Video", data_sugerida: "2026-10-28", horario_sugerido: "20:10" }]), { code: "edit_calendar_registration_invalid" });
});
