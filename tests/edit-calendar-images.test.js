"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const sharp = require("sharp");
const { createEditCalendarService, bindInput } = require("../src/company-edit-calendar/service");
const planning = require("../src/company-monthly-planning/planning.service");
const { atomicWriteJson } = require("../src/notifications/fcm-token-store");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const { createCalendarSource } = require("../src/social/calendar/source");
const { createCalendarMedia } = require("../src/social/calendar/media");
const model = require("../src/social/calendar/model");
const { targets } = require("../src/social/calendar/destinations");
const secret = "synthetic-edit-image-test-secret-only-20261028";

function fixture(t, options = {}) {
  const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, "ia4tube-edit-image-test-"));
  assert.equal(path.dirname(root), temp);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = "synthetic-image-owner", other = "synthetic-other-owner";
  const clientsPath = path.join(root, "clients.json"), planningDir = path.join(root, "planning"), ordersDir = path.join(root, "orders");
  const client = { ativo: true, whatsapp: owner, nome_empresa: "Loja sintética", ramo: "Loja", plano_status: "active",
    plano_renova_em: "2099-01-01", plano_ciclo: "2099-01", artes_mensais_total: 20,
    artes_mensais_restantes: 20, artes_avulsas_restantes: 0 };
  atomicWriteJson(clientsPath, { [owner]: client, [other]: { ...client, whatsapp: other } });
  const readClients = () => JSON.parse(fs.readFileSync(clientsPath, "utf8"));
  const companyId = crypto.randomUUID(), userId = crypto.randomUUID();
  const grants = createCalendarGrants(secret); t.after(() => grants.close());
  const dependencies = { dataDir: root, planningDir, ordersDir, secret, readClients,
    writeClients: value => atomicWriteJson(clientsPath, value),
    prepareCalendarRequest: async () => ({ planningId, quantity }) => grants.issue({ companyId, userId,
      binding: { connectionId: crypto.randomUUID(), externalId: "123456789012345", connectionRevision: 1 },
      revision: 1, planningId, quantity }), ...options };
  const service = createEditCalendarService(dependencies); t.after(() => service.close());
  const contextBody = { requestId: crypto.randomUUID(), date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    time: "14:00", destination: "reel", caption: "Legenda escolhida pelo cliente" };
  const bindBody = ticket => ({ ticket, editOrderId: crypto.randomUUID(), title: "Modelo de imagem sintético",
    caption: "Legenda do operador", durationSeconds: null, inputHash: "a".repeat(64), mediaKind: "image" });
  const source = createCalendarSource({ dataDir: root, planningDir, ordersDir });
  return { root, owner, other, companyId, userId, service, dependencies, contextBody, bindBody, readClients,
    planningDir, ordersDir, source, grants };
}

test("image binding requires an explicit image kind and a null duration; legacy video input stays unchanged", () => {
  const base = { ticket: `${crypto.randomUUID()}.${"a".repeat(43)}`, editOrderId: crypto.randomUUID(), title: "Modelo",
    caption: "Legenda", durationSeconds: null, inputHash: "a".repeat(64), mediaKind: "image" };
  assert.deepEqual(bindInput(base), { editOrderId: base.editOrderId, title: "Modelo", caption: "Legenda",
    durationSeconds: null, inputHash: base.inputHash, mediaKind: "image" });
  for (const durationSeconds of [undefined, 0, 3, 10, "", "null"])
    assert.throws(() => bindInput({ ...base, durationSeconds }), { code: "edit_calendar_input_invalid" });
  for (const mediaKind of [undefined, null, "", "IMAGE", "gif"])
    assert.throws(() => bindInput({ ...base, mediaKind }), { code: "edit_calendar_input_invalid" });
  const { mediaKind, ...legacy } = { ...base, durationSeconds: 10 };
  const legacyNormalized = bindInput(legacy);
  assert.equal(Object.hasOwn(legacyNormalized, "mediaKind"), false);
  assert.equal(legacyNormalized.durationSeconds, 10);
  for (const durationSeconds of [3, 8, 10, 60])
    assert.equal(bindInput({ ...base, mediaKind: "video", durationSeconds }).durationSeconds, durationSeconds);
  for (const durationSeconds of [null, 0, 2.99, 60.01, "10"])
    assert.throws(() => bindInput({ ...base, mediaKind: "video", durationSeconds }), { code: "edit_calendar_input_invalid" });
});

test("a typed Edit image returns through the normal PNG source and prepares existing Feed/Story variants without video work", async t => {
  const f = fixture(t), ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody);
  const body = f.bindBody(ctx.ticket), bound = f.service.bind(body);
  assert.deepEqual(f.service.bind(body), bound);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
  const plan = planning.findPlanningById({ baseDir: f.planningDir, whatsapp: f.owner, planningId: bound.planningId });
  assert.equal(plan.edit_calendar.mediaKind, "image");
  assert.equal(plan.instagram_destination, "feed");
  assert.equal(plan.instagram_layout, "safe_master_v1");
  assert.equal(plan.orientacoes_fotos[0].slot_id, "edit-image");
  assert.equal(plan.orientacoes_fotos[0].objetivo, "Imagem escolhida no Edit");
  assert.deepEqual(planning.listBotPending({ baseDir: f.planningDir, claim: false }).planejamentos, []);
  assert.deepEqual(planning.listPlanningArtPending({ pedidosDir: f.ordersDir }).artes, []);
  assert.equal(f.source.list(f.other).length, 0);

  const result = path.join(f.root, "image-master.png");
  await sharp({ create: { width: 1152, height: 1440, channels: 3, background: "#d92a1c" } }).png().toFile(result);
  planning.savePlanningArtResult({ pedidosDir: f.ordersDir, pedidoId: bound.pedidoId,
    resultadoPath: result, resultadoMime: "image/png", descricaoInstagram: "Outra legenda do operador" });
  const child = planning.findPlanningArtOrder({ pedidosDir: f.ordersDir, pedidoId: bound.pedidoId });
  assert.equal(child.status, "pronto");
  assert.equal(child.pedido.resultado_mime, "image/png");
  assert.equal(child.pedido.resultado_video, null);
  assert.equal(child.pedido.edit_calendar.mediaKind, "image");
  assert.equal(fs.existsSync(path.join(child.base, "resultado_final.mp4")), false);
  const listed = f.source.list(f.owner);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].imageReady, true);
  assert.equal(listed[0].mediaKind, "image");
  assert.equal(listed[0].videoMetadata, null);
  assert.equal(listed[0].date, f.contextBody.date);
  assert.equal(listed[0].time, f.contextBody.time);
  assert.equal(listed[0].caption, f.contextBody.caption);
  assert.ok(f.grants.verify(listed[0].authorizationEnvelope, f.companyId, f.userId));

  const state = model.freshState();
  model.syncSources(state, listed, f.companyId, Date.now());
  const job = Object.values(state.jobs)[0];
  assert.deepEqual(targets(job), ["feed"]);
  const media = createCalendarMedia({ dataDir: f.root, secret, publicOrigin: "https://synthetic.invalid",
    loadSource: f.source.load, describeSource: () => { throw new Error("video preparation must not be used for an image"); } });
  t.after(() => media.close());
  const prepared = await media.prepare(f.owner, f.companyId, job);
  assert.deepEqual([prepared.variants.feed.width, prepared.variants.feed.height], [1080, 1350]);
  assert.deepEqual([prepared.variants.story.width, prepared.variants.story.height], [1080, 1920]);
  const descriptor = media.descriptor(f.companyId, { ...job, asset: prepared.variants.feed, target: "feed" });
  assert.equal(descriptor.mimeType, "image/jpeg");
  assert.equal(descriptor.destination, "feed");
  assert.equal(descriptor.caption, f.contextBody.caption);
  assert.equal((await sharp(media.bytesFor(f.companyId, prepared.variants.feed)).metadata()).width, 1080);
  assert.deepEqual(targets({ ...job, destination: "both" }), ["feed", "story"]);

  const retry = path.join(f.root, "retry.png");
  fs.copyFileSync(path.join(child.base, "resultado_final.png"), retry);
  planning.savePlanningArtResult({ pedidosDir: f.ordersDir, pedidoId: bound.pedidoId, resultadoPath: retry, resultadoMime: "image/png" });
  assert.equal(fs.existsSync(retry), false);
  assert.equal(f.source.list(f.owner).length, 1);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
  assert.throws(() => f.service.bind({ ...body, mediaKind: "video", durationSeconds: 10 }), { code: "edit_calendar_order_conflict" });
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
});

for (const mediaKind of ["image", "video"]) test(`a typed ${mediaKind} order rejects the opposite MIME before changing the source`, async t => {
  const f = fixture(t), ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody);
  const body = { ...f.bindBody(ctx.ticket), mediaKind, durationSeconds: mediaKind === "image" ? null : 10 };
  const bound = f.service.bind(body), file = path.join(f.root, "opposite-format-upload");
  await sharp({ create: { width: 1152, height: 1440, channels: 3, background: "#d92a1c" } }).png().toFile(file);
  assert.throws(() => planning.savePlanningArtResult({ pedidosDir: f.ordersDir, pedidoId: bound.pedidoId,
    resultadoPath: file, resultadoMime: mediaKind === "image" ? "video/mp4" : "image/png" }),
  { code: "edit_calendar_media_type_mismatch", statusCode: 422 });
  const child = planning.findPlanningArtOrder({ pedidosDir: f.ordersDir, pedidoId: bound.pedidoId });
  assert.equal(child.status, "processando");
  assert.equal(fs.existsSync(path.join(child.base, "resultado_final.png")), false);
  assert.equal(fs.existsSync(path.join(child.base, "resultado_final.mp4")), false);
  assert.equal(f.source.list(f.owner)[0].imageReady, false);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
});

test("a stopped image allocation recovers the typed marker, source and one normal credit", async t => {
  let failed = false;
  const f = fixture(t, { fault: stage => {
    if (stage === "after_client_commit" && !failed) { failed = true; throw new Error("synthetic image interruption"); }
  } });
  const ctx = await f.service.createContext({ whatsapp: f.owner }, f.contextBody), body = f.bindBody(ctx.ticket);
  assert.throws(() => f.service.bind(body), /synthetic image interruption/);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
  const fresh = createEditCalendarService({ ...f.dependencies, fault: () => {} }); t.after(() => fresh.close());
  const bound = fresh.bind(body);
  assert.deepEqual(fresh.bind(body), bound);
  assert.equal(f.readClients()[f.owner].artes_mensais_restantes, 19);
  assert.equal(f.source.list(f.owner).length, 1);
  assert.equal(planning.findPlanningArtOrder({ pedidosDir: f.ordersDir, pedidoId: bound.pedidoId }).pedido.edit_calendar.mediaKind, "image");
});
