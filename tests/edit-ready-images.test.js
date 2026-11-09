"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const sharp = require("sharp"), express = require("express"), multer = require("multer");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { createEditCalendarRouter } = require("../src/company-edit-calendar/router");
const { normalizeReadyImage, MAX_INPUT_BYTES } = require("../src/company-edit-calendar/ready-images");
const { admissionOrderId, hash } = require("../src/company-edit-calendar/admission-contract");
const { atomicWriteJson } = require("../src/notifications/fcm-token-store");
const planning = require("../src/company-monthly-planning/planning.service");
const billing = require("../src/billing/billing.service"), plans = require("../src/billing/plans");
const { createCalendarSource } = require("../src/social/calendar/source");
const { createCalendarMedia } = require("../src/social/calendar/media");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const model = require("../src/social/calendar/model");
const secret = "synthetic-ready-images-fixture-key-not-a-real-credential";
const healthy = { provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId: "123456789012345" };

function fixture(t, options = {}) {
  const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, "ia4tube-ready-image-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), temp);
    assert.ok(path.basename(resolved).startsWith("ia4tube-ready-image-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const owner = "synthetic-photo-owner", other = "synthetic-photo-other", clientsFile = path.join(root, "clients.json");
  const client = { ativo: true, nome_empresa: "Loja sintética", ramo: "Loja", arte_gratis_disponivel: false,
    arte_gratis_usada: true, artes_avulsas_restantes: 0 };
  if (!options.free) billing.applyManualPlanPayment(client, plans.getPlan("i4_combo_10i_4v_v1"), "synthetic-photo-payment", new Date());
  else Object.assign(client, { plano_status: "none", artes_mensais_restantes: 0, arte_gratis_disponivel: true,
    arte_gratis_usada: false, arte_gratis_usos: [] });
  Object.assign(client, options.client);
  atomicWriteJson(clientsFile, { [owner]: client, [other]: structuredClone(client) });
  const readClients = () => JSON.parse(fs.readFileSync(clientsFile, "utf8"));
  const writeClients = value => atomicWriteJson(clientsFile, value);
  let now = Date.now();
  const companyId = crypto.randomUUID(), userId = crypto.randomUUID(), binding = {
    connectionId: crypto.randomUUID(), externalId: healthy.externalId, connectionRevision: 1 };
  const grants = createCalendarGrants(secret, () => now); t.after(() => grants.close());
  const dependencies = { dataDir: root, planningDir: path.join(root, "planning"), ordersDir: path.join(root, "orders"),
    secret, readClients, writeClients, admissionEnabled: true, clock: () => now,
    observeConnection: async () => options.connection === undefined ? healthy : options.connection,
    prepareCalendarRequest: async () => options.manual ? null : ({ planningId, quantity }) => grants.issue({
      companyId, userId, binding, revision: 1, planningId, quantity }), ...options.ports };
  const service = createEditCalendarService(dependencies); t.after(() => service.close());
  const claims = who => ({ whatsapp: who, sub: who, company_id: who, token_version: 2,
    iss: "ia4tube-api", aud: "ia4tube-client", jti: crypto.randomUUID() });
  async function context(who = owner, destination = "reel") {
    const input = { requestId: crypto.randomUUID(), date: new Date(now + 2 * 86400000).toISOString().slice(0, 10),
      time: "14:37", destination, caption: "Texto nativo anterior" };
    const result = await service.createContext(claims(who), input);
    return { body: { requestId: input.requestId, ticket: result.ticket, caption: "Minha legenda, sem IA." }, input };
  }
  async function photo(format = "jpeg", color = "#ee4422", width = 300, height = 150) {
    const file = path.join(root, `${crypto.randomUUID()}.${format}`);
    await sharp({ create: { width, height, channels: 3, background: color } })[format]().toFile(file);
    return { path: file, mimetype: `image/${format}`, originalname: `photo.${format}` };
  }
  const current = () => readClients()[owner];
  const source = createCalendarSource({ dataDir: root, planningDir: dependencies.planningDir, ordersDir: dependencies.ordersDir });
  return { root, owner, other, dependencies, service, readClients, writeClients, current, context, photo, source,
    companyId, userId, binding, grants, setNow: value => { now = value; } };
}

test("photo is normalized once to the existing safe master without crop, distortion or EXIF", async t => {
  const f = fixture(t), file = await f.photo("png", "#ff0000", 400, 200);
  const normalized = await normalizeReadyImage(file), metadata = await sharp(normalized.bytes).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ["png", 1152, 1440]);
  assert.equal(metadata.exif, undefined);
  const { data, info } = await sharp(normalized.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  assert.deepEqual(pixel(0, 431), [255, 255, 255]);
  assert.deepEqual(pixel(0, 432), [255, 0, 0]);
  assert.deepEqual(pixel(1151, 1007), [255, 0, 0]);
  assert.deepEqual(pixel(1151, 1008), [255, 255, 255]);
  const rotated = path.join(f.root, "rotated.jpeg");
  await sharp({ create: { width: 100, height: 200, channels: 3, background: "blue" } })
    .withMetadata({ orientation: 6, exif: { IFD0: { Artist: "Synthetic fixture" } } }).jpeg().toFile(rotated);
  const result = await normalizeReadyImage({ path: rotated, mimetype: "image/jpeg" });
  assert.equal((await sharp(result.bytes).metadata()).exif, undefined);
});

test("finished photo uses one image quota and the unchanged image calendar source/Feed/Story preparation", async t => {
  const f = fixture(t), selected = await f.context(), file = await f.photo();
  const result = await f.service.submitReadyImage(selected.body, file);
  assert.equal(result.status, "ready"); assert.equal(result.automatic, true);
  assert.equal(result.requestId, selected.body.requestId);
  assert.equal(f.current().artes_mensais_restantes, 9); assert.equal(f.current().videos_mensais_restantes, 4);
  assert.equal(Object.keys(f.current().planejamento_mensal_reservas).length, 1);
  assert.deepEqual(planning.listBotPending({ baseDir: f.dependencies.planningDir, claim: false }).planejamentos, []);
  assert.deepEqual(planning.listPlanningArtPending({ pedidosDir: f.dependencies.ordersDir }).artes, []);
  const listed = f.source.list(f.owner); assert.equal(listed.length, 1);
  const item = listed[0];
  assert.equal(item.date, selected.input.date); assert.equal(item.time, selected.input.time);
  assert.equal(item.caption, selected.body.caption); assert.equal(item.destination, "feed");
  assert.equal(item.mediaKind, "image"); assert.equal(item.imageReady, true);
  assert.equal(f.source.list(f.other).length, 0);
  assert.ok(f.grants.verify(item.authorizationEnvelope, f.companyId, f.userId));
  const state = model.freshState(); model.syncSources(state, listed, f.companyId, Date.now());
  const job = Object.values(state.jobs)[0]; assert.equal(job.sourceKind, undefined);
  const media = createCalendarMedia({ dataDir: f.root, secret, publicOrigin: "https://synthetic.invalid", loadSource: f.source.load });
  t.after(() => media.close());
  const prepared = await media.prepare(f.owner, f.companyId, job);
  assert.deepEqual([prepared.variants.feed.width, prepared.variants.feed.height], [1080, 1350]);
  assert.deepEqual([prepared.variants.story.width, prepared.variants.story.height], [1080, 1920]);
  assert.equal(f.current().artes_mensais_restantes, 9);
});

test("a finished photo selected for Feed and Story uses one image quota and keeps both targets after finalization", async t => {
  const f = fixture(t), selected = await f.context(f.owner, "both"), file = await f.photo();
  const receipt = await f.service.submitReadyImage(selected.body, file);
  assert.deepEqual(await f.service.submitReadyImage(selected.body, file), receipt);
  assert.equal(f.current().artes_mensais_restantes, 9); assert.equal(f.current().videos_mensais_restantes, 4);
  const items = f.source.list(f.owner); assert.equal(items.length, 1);
  assert.equal(items[0].destination, "both"); assert.equal(items[0].imageReady, true);
  assert.equal(items[0].date, selected.input.date); assert.equal(items[0].time, selected.input.time);
  const state = model.freshState(); model.syncSources(state, items, f.companyId, Date.now());
  assert.deepEqual(require("../src/social/calendar/destinations").targets(Object.values(state.jobs)[0]), ["feed", "story"]);
});

test("same request and content retries return the same receipt; changed photo/caption cannot replace it", async t => {
  const f = fixture(t), { body } = await f.context(), file = await f.photo();
  const first = await f.service.submitReadyImage(body, file);
  assert.deepEqual(await f.service.submitReadyImage(body, file), first);
  await assert.rejects(f.service.submitReadyImage({ ...body, caption: "Outra legenda" }, file), { code: "edit_calendar_order_conflict" });
  await assert.rejects(f.service.submitReadyImage(body, await f.photo("png", "green")), { code: "edit_calendar_order_conflict" });
  assert.equal(f.current().artes_mensais_restantes, 9); assert.equal(f.source.list(f.owner).length, 1);
});

for (const variant of ["missing", "garbage", "mime", "oversize", "pixels", "empty-caption", "long-caption", "extra-owner", "other-id", "past"])
  test(`invalid ${variant} is refused before a quota or producer exists`, async t => {
    const f = fixture(t), { body, input } = await f.context(); let file = await f.photo();
    if (variant === "missing") file = null;
    if (variant === "garbage") fs.writeFileSync(file.path, "not an image");
    if (variant === "mime") file.mimetype = "image/png";
    if (variant === "oversize") fs.writeFileSync(file.path, Buffer.alloc(MAX_INPUT_BYTES + 1));
    if (variant === "pixels") file = await f.photo("png", "red", 5001, 5001);
    if (variant === "empty-caption") body.caption = "  ";
    if (variant === "long-caption") body.caption = "a".repeat(2201);
    if (variant === "extra-owner") body.owner = f.other;
    if (variant === "other-id") body.requestId = crypto.randomUUID();
    if (variant === "past") f.setNow(model.dateTime(input.date, input.time) + 1);
    const before = f.readClients(); await assert.rejects(f.service.submitReadyImage(body, file));
    assert.deepEqual(f.readClients(), before); assert.equal(f.source.list(f.owner).length, 0);
    assert.equal(f.service.readyImageCanEdit(body.ticket), true);
  });

test("deactivated/forged tickets cannot upload, and a video/catalog ticket cannot be reused for a finished photo", async t => {
  const f = fixture(t), { body } = await f.context(), file = await f.photo(), before = f.readClients();
  await assert.rejects(f.service.submitReadyImage({ ...body, ticket: body.ticket.slice(0, 37) + "z".repeat(43) }, file),
    { code: "edit_calendar_context_unavailable" });
  const request = { schemaVersion: 1, ticket: body.ticket, editOrderId: admissionOrderId(body.ticket), requestHash: hash("catalog-video"),
    mediaKind: "video", title: "Vídeo do catálogo", caption: "Legenda", durationSeconds: 10,
    selection: { modelId: crypto.randomUUID(), modelVersion: 1, sourceDigest: hash("catalog") }, quantity: 1 };
  await f.service.admit(request);
  await assert.rejects(f.service.submitReadyImage(body, file), { code: "edit_calendar_order_conflict" });
  assert.equal(f.current().artes_mensais_restantes, before[f.owner].artes_mensais_restantes);
  assert.equal(f.current().videos_mensais_restantes, 3);
  const fresh = await f.context(), clients = f.readClients(); clients[f.owner].ativo = false; f.writeClients(clients);
  assert.throws(() => f.service.verifyReadyImageCapability(fresh.body.ticket), { code: "edit_calendar_session_required" });
});

for (const stage of ["ready_image_after_admission", "ready_image_after_bind", "ready_image_after_result"])
  test(`restart/retry after ${stage} preserves exactly one quota, result and chosen schedule`, async t => {
    let once = false;
    const f = fixture(t, { ports: { fault: current => { if (current === stage && !once) { once = true; throw new Error("synthetic interruption"); } } } });
    const { body, input } = await f.context(), file = await f.photo();
    await assert.rejects(f.service.submitReadyImage(body, file), /synthetic interruption/);
    assert.equal(f.current().artes_mensais_restantes, 9); assert.equal(f.service.readyImageCanEdit(body.ticket), false);
    const restarted = createEditCalendarService({ ...f.dependencies, fault: () => {} }); t.after(() => restarted.close());
    const recovered = await restarted.submitReadyImage(body, file);
    assert.deepEqual(await restarted.submitReadyImage(body, file), recovered);
    assert.equal(f.current().artes_mensais_restantes, 9); assert.equal(f.source.list(f.owner).length, 1);
    assert.equal(f.source.list(f.owner)[0].time, input.time);
  });

test("the normalized photo is durable before admission and its retry does not spend twice", async t => {
  let once = false;
  const f = fixture(t, { ports: { fault: stage => { if (stage === "ready_image_after_staging" && !once) {
    once = true; throw new Error("synthetic pre-admission interruption"); } } } });
  const { body } = await f.context(), file = await f.photo();
  await assert.rejects(f.service.submitReadyImage(body, file), /synthetic pre-admission interruption/);
  assert.equal(f.current().artes_mensais_restantes, 10);
  const stageRoot = path.join(f.root, "private/edit-calendar/ready-images");
  assert.equal(fs.readdirSync(stageRoot).filter(name => name.endsWith(".png")).length, 1);
  await f.service.submitReadyImage(body, file);
  assert.equal(f.current().artes_mensais_restantes, 9);
  assert.equal(fs.readdirSync(stageRoot).filter(name => name.endsWith(".png")).length, 0);
});

test("the ready-image producer fence is rechecked under the ordinary admission allocation lock", async t => {
  const f = fixture(t), { body } = await f.context();
  const request = { schemaVersion: 1, ticket: body.ticket, editOrderId: admissionOrderId(body.ticket), requestHash: hash("other-producer"),
    mediaKind: "video", title: "Vídeo", caption: "Legenda", durationSeconds: 10,
    selection: { modelId: crypto.randomUUID(), modelVersion: 1, sourceDigest: hash("catalog") }, quantity: 1 };
  const contextPath = path.join(f.root, "private/edit-calendar/contexts", `${body.requestId}.json`);
  const originalOpen = fs.openSync; let inserted = false;
  fs.openSync = function (filename, flags, ...args) {
    const fd = originalOpen.call(fs, filename, flags, ...args);
    if (!inserted && String(filename).endsWith("allocation.lock") && flags === "wx") {
      inserted = true;
      const row = JSON.parse(fs.readFileSync(contextPath, "utf8"));
      row.readyImage = { requestHash: hash("finished-image"), sourceDigest: hash("photo"),
        modelId: crypto.randomUUID(), caption: "Minha imagem" };
      atomicWriteJson(contextPath, row);
    }
    return fd;
  };
  try { await assert.rejects(f.service.admit(request), { code: "edit_calendar_order_conflict" }); }
  finally { fs.openSync = originalOpen; }
  assert.equal(inserted, true); assert.equal(f.current().artes_mensais_restantes, 10);
  assert.equal(f.current().videos_mensais_restantes, 4);
});

test("a dead same-host image lock can be recovered, while ambiguous ownership fails closed", async t => {
  let once = false;
  const f = fixture(t, { ports: { fault: stage => { if (stage === "ready_image_after_staging" && !once) {
    once = true; throw new Error("synthetic stale-lock preparation"); } } } });
  const { body } = await f.context(), file = await f.photo();
  await assert.rejects(f.service.submitReadyImage(body, file), /synthetic stale-lock preparation/);
  const lock = path.join(f.root, "private/edit-calendar/ready-images", `${body.requestId}.lock`);
  fs.writeFileSync(lock, JSON.stringify({ hostname: "synthetic-other-host", pid: 2147483647 }));
  await assert.rejects(f.service.submitReadyImage(body, file), { code: "edit_calendar_allocation_busy" });
  assert.equal(f.current().artes_mensais_restantes, 10);
  fs.writeFileSync(lock, JSON.stringify({ hostname: os.hostname(), pid: 2147483647 }));
  await f.service.submitReadyImage(body, file);
  assert.equal(f.current().artes_mensais_restantes, 9);
});

test("concurrent duplicate submissions converge on one credit and one child", async t => {
  const f = fixture(t), { body } = await f.context(), file = await f.photo();
  const results = await Promise.allSettled([f.service.submitReadyImage(body, file), f.service.submitReadyImage(body, file)]);
  assert.ok(results.some(result => result.status === "fulfilled"));
  for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "edit_calendar_allocation_busy");
  await f.service.submitReadyImage(body, file);
  assert.equal(f.current().artes_mensais_restantes, 9); assert.equal(f.source.list(f.owner).length, 1);
});

test("existing single Instagram image benefit stays single and requires a healthy connection", async t => {
  const f = fixture(t, { free: true }), first = await f.context(), file = await f.photo();
  await f.service.submitReadyImage(first.body, file);
  assert.equal(f.current().arte_gratis_usada, true); assert.equal(f.current().arte_gratis_usos.length, 1);
  const second = await f.context(); await assert.rejects(f.service.submitReadyImage(second.body, file), { code: "billing_required" });
  assert.equal(f.current().arte_gratis_usos.length, 1); assert.equal(f.source.list(f.owner).length, 1);
  const absent = fixture(t, { free: true, connection: null }), pending = await absent.context();
  await assert.rejects(absent.service.submitReadyImage(pending.body, await absent.photo()), { code: "billing_required" });
  assert.equal(absent.current().arte_gratis_usada, false);
});

test("no image quota does not spend a video quota, and paid manual consent is not enabled implicitly", async t => {
  const f = fixture(t), client = f.readClients(); client[f.owner].artes_mensais_restantes = 0; f.writeClients(client);
  const { body } = await f.context(); await assert.rejects(f.service.submitReadyImage(body, await f.photo()), { code: "billing_required" });
  assert.equal(f.current().videos_mensais_restantes, 4);
  const manual = fixture(t, { manual: true }), request = await manual.context();
  assert.equal((await manual.service.submitReadyImage(request.body, await manual.photo())).automatic, false);
  assert.equal(manual.source.list(manual.owner)[0].authorizationEnvelope, null);
});

test("HTTP requires the header ticket before multipart and returns safe-to-edit only before admission", async t => {
  const f = fixture(t), { body } = await f.context(), file = await f.photo(); let uploads = 0;
  const upload = multer({ dest: f.root, limits: { files: 1, fields: 3, parts: 5, fileSize: MAX_INPUT_BYTES } }).single("image");
  const app = express(); app.use(createEditCalendarRouter({ authenticate: (_req, res) => res.sendStatus(401),
    botAuthenticate: (_req, res) => res.sendStatus(401), isBotAdmin: () => false, service: f.service,
    readyImageUpload: (req, res, next) => { uploads++; upload(req, res, next); },
    readyImageCleanup: uploaded => { if (uploaded?.path && fs.existsSync(uploaded.path)) fs.unlinkSync(uploaded.path); } }));
  const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/empresa/edit/ready-images`;
  const form = (caption = body.caption, bytes = fs.readFileSync(file.path)) => {
    const value = new FormData(); value.set("ticket", body.ticket); value.set("requestId", body.requestId); value.set("caption", caption);
    value.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpeg"); return value;
  };
  const unauthorized = await fetch(url, { method: "POST", body: form() }); assert.equal(unauthorized.status, 401); assert.equal(uploads, 0);
  const headers = { Authorization: `EditTicket ${body.ticket}` };
  const invalid = await fetch(url, { method: "POST", headers, body: form("", Buffer.from("bad")) });
  assert.equal(invalid.status, 422); assert.equal((await invalid.json()).safeToEdit, true);
  const success = await fetch(url, { method: "POST", headers, body: form() }); assert.equal(success.status, 200);
  const receipt = await success.json(); assert.equal(receipt.status, "ready");
  const conflict = await fetch(url, { method: "POST", headers, body: form("Outro texto") });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).safeToEdit, undefined);
  const repeated = await fetch(url, { method: "POST", headers, body: form() }); assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), receipt); assert.equal(f.current().artes_mensais_restantes, 9);
});

function adaptation(t, onRequest = () => {}) {
  let calls = 0;
  const adapter = require("../src/company-edit-calendar/ready-image-feed-adaptation").createReadyImageFeedAdapter({
    apiKey: "synthetic-adaptation-key", fetchImpl: async () => {
      calls++; await onRequest();
      const bytes = await sharp({ create: { width: 1152, height: 1440, channels: 3, background: "blue" } }).png().toBuffer();
      return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }), { status: 200 });
    } });
  return { adapter, calls: () => calls };
}

test("adaptation reserves one image before its only POST and rejoins the same Feed/Story source", async t => {
  let f; const ai = adaptation(t, () => {
    assert.equal(f.current().artes_mensais_restantes, 9);
    assert.equal(planning.listPlanningArtPending({ pedidosDir: f.dependencies.ordersDir }).artes.length, 0);
  });
  f = fixture(t, { ports: { readyImageFeedAdapter: ai.adapter } });
  const selected = await f.context(f.owner, "both"), file = await f.photo("jpeg", "red", 900, 1600);
  const receipt = await f.service.submitReadyImage(selected.body, file);
  assert.deepEqual(await f.service.submitReadyImage(selected.body, file), receipt);
  const restarted = createEditCalendarService(f.dependencies); t.after(() => restarted.close());
  assert.deepEqual(await restarted.submitReadyImage(selected.body, file), receipt);
  assert.equal(ai.calls(), 1); assert.equal(f.current().artes_mensais_restantes, 9);
  assert.equal(f.current().videos_mensais_restantes, 4);
  const items = f.source.list(f.owner); assert.equal(items.length, 1);
  assert.deepEqual([items[0].date, items[0].time, items[0].caption, items[0].destination],
    [selected.input.date, selected.input.time, selected.body.caption, "both"]);
  const state = model.freshState(); model.syncSources(state, items, f.companyId, Date.now());
  const media = createCalendarMedia({ dataDir: f.root, secret, publicOrigin: "https://synthetic.invalid", loadSource: f.source.load });
  t.after(() => media.close());
  const prepared = await media.prepare(f.owner, f.companyId, Object.values(state.jobs)[0]);
  assert.deepEqual([prepared.variants.feed.width, prepared.variants.feed.height], [1080, 1350]);
  assert.deepEqual([prepared.variants.story.width, prepared.variants.story.height], [1080, 1920]);
});

test("4:5 needs no paid adaptation, and no image quota cannot call the API", async t => {
  const ai = adaptation(t), f = fixture(t, { ports: { readyImageFeedAdapter: ai.adapter } });
  await f.service.submitReadyImage((await f.context()).body, await f.photo("png", "red", 800, 1000));
  assert.equal(ai.calls(), 0); assert.equal(f.current().artes_mensais_restantes, 9);
  const clients = f.readClients(); clients[f.owner].artes_mensais_restantes = 0; f.writeClients(clients);
  await assert.rejects(f.service.submitReadyImage((await f.context()).body, await f.photo()), { code: "billing_required" });
  assert.equal(ai.calls(), 0); assert.equal(f.current().videos_mensais_restantes, 4);
});

for (const stage of ["ready_image_after_adaptation", "ready_image_after_bind", "ready_image_after_result"])
  test(`interruption ${stage} reuses one adaptation and one quota after restart`, async t => {
    let once = false; const ai = adaptation(t), f = fixture(t, { ports: {
      readyImageFeedAdapter: ai.adapter, fault: point => { if (point === stage && !once) {
        once = true; throw Error("synthetic adaptation interruption"); } } } });
    const selected = await f.context(), file = await f.photo();
    await assert.rejects(f.service.submitReadyImage(selected.body, file), /synthetic adaptation interruption/);
    const restarted = createEditCalendarService(f.dependencies); t.after(() => restarted.close());
    await restarted.submitReadyImage(selected.body, file);
    assert.equal(ai.calls(), 1); assert.equal(f.current().artes_mensais_restantes, 9);
    assert.equal(f.source.list(f.owner).length, 1);
  });

test("legacy accepted photos remain byte-identical when adaptation becomes available", async t => {
  let once = false; const f = fixture(t, { ports: { fault: point => {
    if (point === "ready_image_after_staging" && !once) { once = true; throw Error("synthetic legacy interruption"); }
  } } });
  const selected = await f.context(), file = await f.photo(), normalized = await normalizeReadyImage(file);
  await assert.rejects(f.service.submitReadyImage(selected.body, file), /synthetic legacy interruption/);
  const ai = adaptation(t), restarted = createEditCalendarService({ ...f.dependencies, readyImageFeedAdapter: ai.adapter });
  t.after(() => restarted.close()); await restarted.submitReadyImage(selected.body, file);
  const found = planning.findPlanningArtOrder({ pedidosDir: f.dependencies.ordersDir, pedidoId: `edit_${selected.body.requestId.replace(/-/g, "")}` });
  assert.equal(hash(fs.readFileSync(path.join(found.base, "resultado_final.png"))), normalized.normalizedDigest);
  assert.equal(ai.calls(), 0);
});

test("concurrent duplicates and changed content cannot trigger a second paid adaptation", async t => {
  let started, finish;
  const began = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { finish = resolve; });
  const ai = adaptation(t, async () => { started(); await wait; });
  const f = fixture(t, { ports: { readyImageFeedAdapter: ai.adapter } }), selected = await f.context(), file = await f.photo();
  const first = f.service.submitReadyImage(selected.body, file);
  await began;
  try {
    await assert.rejects(f.service.submitReadyImage(selected.body, file), { code: "edit_calendar_allocation_busy" });
    assert.equal(ai.calls(), 1);
  } finally { finish(); }
  const receipt = await first;
  await assert.rejects(f.service.submitReadyImage({ ...selected.body, caption: "Outra legenda" }, file),
    { code: "edit_calendar_order_conflict" });
  await assert.rejects(f.service.submitReadyImage(selected.body, await f.photo("png", "green")),
    { code: "edit_calendar_order_conflict" });
  assert.deepEqual(await f.service.submitReadyImage(selected.body, file), receipt);
  assert.equal(ai.calls(), 1); assert.equal(f.current().artes_mensais_restantes, 9);
});

test("failed adaptation cannot finalize or publish the padded original and cannot retry the API", async t => {
  let calls = 0;
  const adapter = require("../src/company-edit-calendar/ready-image-feed-adaptation").createReadyImageFeedAdapter({
    apiKey: "synthetic-key", fetchImpl: async () => { calls++; throw Error("synthetic offline"); } });
  const f = fixture(t, { ports: { readyImageFeedAdapter: adapter } }), selected = await f.context(), file = await f.photo();
  for (let i = 0; i < 2; i++) await assert.rejects(f.service.submitReadyImage(selected.body, file),
    { code: "edit_calendar_ready_image_adaptation_preserved" });
  assert.equal(calls, 1); assert.equal(f.current().artes_mensais_restantes, 9);
  assert.equal(f.source.list(f.owner).filter(item => item.imageReady).length, 0);
  assert.equal(planning.listPlanningArtPending({ pedidosDir: f.dependencies.ordersDir }).artes.length, 0);
});

test("missing API configuration fails before any balance is reserved", async t => {
  const adapter = require("../src/company-edit-calendar/ready-image-feed-adaptation").createReadyImageFeedAdapter();
  const f = fixture(t, { ports: { readyImageFeedAdapter: adapter } }), selected = await f.context();
  await assert.rejects(f.service.submitReadyImage(selected.body, await f.photo()),
    { code: "edit_calendar_ready_image_adaptation_unavailable" });
  assert.equal(f.current().artes_mensais_restantes, 10); assert.equal(f.source.list(f.owner).length, 0);
});

test("caption assistance hands only its final text to the unchanged one-credit image/Feed/Story return", async t => {
  let calls = 0;
  const f = fixture(t, { ports: { imageCaptionOptions: { apiKey: "synthetic-key", fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ status: "completed", output: [{ type: "message",
      content: [{ type: "output_text", text: "Confira este combo! #MinhaMarca" }] }] }), { status: 200 });
  } } } });
  const selected = await f.context(f.owner, "both"), file = await f.photo();
  const request = { requestId: selected.body.requestId, ticket: selected.body.ticket, guidance: "Destaque o combo #MinhaMarca" };
  const generated = await f.service.generateImageCaption(request, file);
  assert.equal(f.current().artes_mensais_restantes, 10);
  await f.service.submitReadyImage({ ...selected.body, caption: generated.caption }, file);
  assert.deepEqual(await f.service.generateImageCaption(request, file), generated);
  const item = f.source.list(f.owner)[0];
  assert.equal(item.caption, "Confira este combo! #MinhaMarca"); assert.equal(item.destination, "both");
  assert.equal(item.date, selected.input.date); assert.equal(item.time, selected.input.time);
  assert.equal(f.current().artes_mensais_restantes, 9); assert.equal(calls, 1);
});

test("caption HTTP is authenticated before multipart, correctable before its first call and reusable after admission", async t => {
  let calls = 0, uploads = 0;
  const f = fixture(t, { ports: { imageCaptionOptions: { apiKey: "synthetic-key", fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [
      { type: "output_text", text: "Legenda gerada. #MinhaMarca" }] }] }), { status: 200 });
  } } } });
  const selected = await f.context(), file = await f.photo(), app = express();
  const upload = multer({ dest: f.root, limits: { files: 1, fields: 3, parts: 5, fileSize: MAX_INPUT_BYTES } }).single("image");
  app.use(createEditCalendarRouter({ authenticate: (_req, res) => res.sendStatus(401), botAuthenticate: (_req, res) => res.sendStatus(401),
    isBotAdmin: () => false, service: f.service, readyImageUpload: (req, res, next) => { uploads++; upload(req, res, next); },
    readyImageCleanup: uploaded => { if (uploaded?.path && fs.existsSync(uploaded.path)) fs.unlinkSync(uploaded.path); } }));
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/empresa/edit/ready-images/caption`;
  const form = (invalid = false) => {
    const body = new FormData(); body.set("requestId", selected.body.requestId); body.set("ticket", selected.body.ticket);
    body.set("guidance", "#MinhaMarca"); body.set("image", new Blob([invalid ? Buffer.from("bad") : fs.readFileSync(file.path)],
      { type: "image/jpeg" }), "photo.jpeg"); return body;
  };
  assert.equal((await fetch(url, { method: "POST", body: form() })).status, 401); assert.equal(uploads, 0);
  const headers = { Authorization: `EditTicket ${selected.body.ticket}` };
  const bad = await fetch(url, { method: "POST", headers, body: form(true) });
  assert.equal(bad.status, 422); assert.equal((await bad.json()).safeToEdit, true); assert.equal(calls, 0);
  const first = await fetch(url, { method: "POST", headers, body: form() }); assert.equal(first.status, 200);
  const generated = await first.json(); assert.equal(generated.caption, "Legenda gerada. #MinhaMarca");
  await f.service.submitReadyImage({ ...selected.body, caption: generated.caption }, file);
  const retry = await fetch(url, { method: "POST", headers, body: form() }); assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), generated); assert.equal(calls, 1); assert.equal(f.current().artes_mensais_restantes, 9);
});
