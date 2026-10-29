"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const planning = require("../src/company-monthly-planning/planning.service");
const orders = require("../src/orders/order.storage");
const { createCalendarSource } = require("../src/social/calendar/source");
const { consentPath } = require("../src/social/calendar/model");

function fixture(t) {
  const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, "ia4tube-calendar-read-context-"));
  assert.equal(path.dirname(root), temp);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planningDir = path.join(root, "planning"), ordersDir = path.join(root, "orders");
  const owner = "synthetic-owner-a", other = "synthetic-owner-b";
  fs.mkdirSync(ordersDir);
  function json(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }
  function plan(id, posts, options = {}) {
    const account = options.owner || owner, cycle = options.cycle || "2099-01";
    const base = path.join(planningDir, account, cycle, id);
    json(path.join(base, "solicitacao.json"), { id, planejamento_id: id, whatsapp: account,
      ciclo: cycle, status: options.status || "pronto", criado_em: `${cycle}-01T00:00:00Z`,
      instagram_destination: options.destination || "feed", instagram_layout: options.layout || "safe_master_v1" });
    json(path.join(base, "plano_mensal.json"), { postagens: posts });
    // No pedidos_criados.json: old installations also discover child orders from their files.
    if (options.envelope) json(consentPath(planningDir, account, id), { envelope: options.envelope });
    return base;
  }
  function order(id, planningId, itemId, options = {}) {
    const account = options.owner || owner, cycle = options.cycle || "2099-01";
    const base = path.join(ordersDir, account, cycle, id);
    const pedido = { id, whatsapp: account, origem: "planejamento_mensal", planejamento_id: planningId,
      planejamento_item_id: itemId, criado_em: options.createdAt || `${cycle}-01T00:00:00Z`,
      status: options.status || "pronto", descricao_instagram: options.caption || `Caption ${id}`,
      planejamento_mensal: { planejamento_id: planningId, planejamento_item_id: itemId, ordem: options.order || 1 },
      ...options.pedido };
    json(path.join(base, "pedido.json"), pedido);
    fs.writeFileSync(path.join(base, "status.txt"), `${pedido.status}\n`);
    if (options.ready !== false) fs.writeFileSync(path.join(base,
      pedido.resultado_mime === "video/mp4" ? "resultado_final.mp4" : "resultado_final.png"),
      options.bytes || Buffer.from(`synthetic-result-${id}-${cycle}`));
    return { base, pedido };
  }
  return { root, planningDir, ordersDir, owner, other, json, plan, order,
    source: createCalendarSource({ dataDir: root, planningDir, ordersDir }) };
}

function post(id, order, date, pedidoId) {
  return { planejamento_item_id: id, ordem: order, tema: `Title ${id}`, objetivo: "Divulgar",
    data_sugerida: date, horario_sugerido: "12:00", ...(pedidoId ? { pedido_id: pedidoId } : {}) };
}

function tree(root) {
  const result = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else result.push([path.relative(root, file), fs.statSync(file).mtimeMs,
        crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
    }
  }
  visit(root);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

function query(f, read) {
  const before = tree(f.root), calls = [], attemptedMutations = [], originalList = orders.listPedidoBasesByWhatsapp;
  const mutations = ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync",
    "rmSync", "copyFileSync", "truncateSync", "linkSync", "symlinkSync"];
  const originals = new Map(mutations.map(name => [name, fs[name]]));
  orders.listPedidoBasesByWhatsapp = (...args) => { calls.push(args); return originalList(...args); };
  for (const name of mutations) fs[name] = () => {
    attemptedMutations.push(name);
    throw Error(`Calendar query attempted ${name}`);
  };
  let value;
  try { value = read(); }
  finally {
    orders.listPedidoBasesByWhatsapp = originalList;
    for (const [name, original] of originals) fs[name] = original;
  }
  assert.deepEqual(attemptedMutations, [], "a list query must not attempt writes even if an inner catch hides the error");
  assert.deepEqual(tree(f.root), before, "a list query must leave every fixture file unchanged");
  return { value, calls };
}

function singleOwnerScan(f, result, owner = f.owner) {
  assert.deepEqual(result.calls.map(args => [args[0], args[1]]), [[f.ordersDir, owner]],
    "each query shares exactly one complete order scan for its owner");
}

test("one list shares its owner scan while preserving source fields, fallback orders and image/video readiness", t => {
  const f = fixture(t), videoMetadata = { width: 720, height: 1280, durationSeconds: 4, hasAudio: true };
  const empty = query(f, () => f.source.list(f.owner));
  assert.deepEqual(empty.value, []); assert.deepEqual(empty.calls, []);
  f.plan("plan-a", [post("image", 1, "2099-01-03", "image-order"), post("pending", 2, "2099-01-04")],
    { envelope: "synthetic-consent-a" });
  f.plan("plan-b", [post("video", 1, "2099-01-02")], { destination: "reel", layout: "synthetic-video-layout" });
  const image = f.order("image-order", "plan-a", "image", { caption: "Original image caption" });
  f.order("pending-order", "plan-a", "pending", { ready: false, status: "processando" });
  const video = f.order("video-order", "plan-b", "video", {
    pedido: { resultado_mime: "video/mp4", resultado_video: videoMetadata } });
  f.plan("other-plan", [post("other", 1, "2099-01-01")], { owner: f.other });
  f.order("other-order", "other-plan", "other", { owner: f.other, caption: "Other owner caption" });
  const listed = query(f, () => f.source.list(f.owner)); singleOwnerScan(f, listed);
  assert.deepEqual(listed.value.map(item => [item.key, item.planningId, item.orderId, item.title, item.date,
    item.time, item.caption, item.imageReady, item.mediaKind, item.videoMetadata, item.authorizationEnvelope,
    item.destination, item.layout]), [
    ["plan-b:video", "plan-b", "video-order", "Title video", "2099-01-02", "12:00", "Caption video-order",
      true, "video", videoMetadata, null, "reel", "synthetic-video-layout"],
    ["plan-a:image", "plan-a", "image-order", "Title image", "2099-01-03", "12:00", "Original image caption",
      true, "image", null, "synthetic-consent-a", "feed", "safe_master_v1"],
    ["plan-a:pending", "plan-a", "pending-order", "Title pending", "2099-01-04", "12:00", "Caption pending-order",
      false, "image", null, "synthetic-consent-a", "feed", "safe_master_v1"]
  ]);
  for (const [row, entry, suffix] of [[listed.value[0], video, ":video"], [listed.value[1], image, ""]]) {
    const stat = fs.statSync(path.join(entry.base, suffix ? "resultado_final.mp4" : "resultado_final.png"));
    assert.equal(row.version, `${stat.size}:${stat.mtimeMs}${suffix}`);
  }
  assert.equal(listed.value[2].version, "pending");
  assert.equal(listed.value[0].calendarPayload.thumbnail_url, "");
  assert.match(listed.value[1].calendarPayload.thumbnail_url, /^\/pedidos\/image-order\/thumbnail\?v=/);
  const direct = query(f, () => planning.listClientPlanningCalendar({
    baseDir: f.planningDir, whatsapp: f.owner, pedidosDir: f.ordersDir })); singleOwnerScan(f, direct);
  assert.deepEqual(direct.value.postagens, listed.value.map(item => item.calendarPayload));
  assert.deepEqual(direct.value.itens, direct.value.postagens);
  const other = query(f, () => f.source.list(f.other)); singleOwnerScan(f, other, f.other);
  assert.deepEqual(other.value.map(item => item.orderId), ["other-order"]);
  assert.equal(other.value[0].authorizationEnvelope, null);
  assert.throws(() => f.source.describe(f.other, listed.value[1]), { code: "calendar_source_unavailable" });
});

test("successive queries see new children, artwork, captions and cancellations without retaining a read context", async t => {
  const f = fixture(t), plan = f.plan("fresh-plan", [post("one", 1, "2099-01-02")]);
  const first = f.order("first-order", "fresh-plan", "one", { ready: false, status: "processando" });
  const initial = query(f, () => f.source.list(f.owner)); singleOwnerScan(f, initial);
  assert.equal(initial.value[0].imageReady, false);
  const bytes = Buffer.from("a newly available private artwork");
  fs.writeFileSync(path.join(first.base, "resultado_final.png"), bytes);
  f.json(path.join(first.base, "pedido.json"), { ...first.pedido, descricao_instagram: "Updated caption" });
  f.json(path.join(plan, "plano_mensal.json"), { postagens: [post("one", 1, "2099-01-02"), post("two", 2, "2099-01-03")] });
  f.order("second-order", "fresh-plan", "two");
  const updated = query(f, () => f.source.list(f.owner)); singleOwnerScan(f, updated);
  assert.deepEqual(updated.value.map(item => [item.orderId, item.imageReady, item.caption]), [
    ["first-order", true, "Updated caption"], ["second-order", true, "Caption second-order"]
  ]);
  assert.deepEqual(await f.source.load(f.owner, updated.value[0]), bytes);
  const previousVersion = updated.value[0].version;
  fs.writeFileSync(path.join(first.base, "resultado_final.png"), Buffer.from("replacement artwork with different bytes and size"));
  assert.notEqual(f.source.describe(f.owner, updated.value[0]).version, previousVersion,
    "describe must inspect the current file rather than retain a completed list snapshot");
  f.json(path.join(first.base, "pedido.json"), { ...first.pedido, pagamento_pendente: true });
  assert.throws(() => f.source.describe(f.owner, updated.value[0]), { code: "calendar_source_unavailable" });
  await assert.rejects(f.source.load(f.owner, updated.value[0]), { code: "calendar_source_unavailable" });
  f.json(path.join(first.base, "pedido.json"), { ...first.pedido, pode_baixar: false });
  assert.throws(() => f.source.describe(f.owner, updated.value[0]), { code: "calendar_source_unavailable" });
  f.json(path.join(first.base, "pedido.json"), { ...first.pedido, whatsapp: f.other });
  assert.throws(() => f.source.describe(f.owner, updated.value[0]), { code: "calendar_source_unavailable" });
  fs.writeFileSync(path.join(plan, "status.txt"), "cancelado\n");
  const cancelled = query(f, () => f.source.list(f.owner));
  assert.deepEqual(cancelled.value, []);
  assert.ok(cancelled.calls.length <= 1, "cancelled plans must never cause repeated owner scans");
  assert.throws(() => f.source.describe(f.owner, updated.value[1]), { code: "calendar_source_unavailable" });
  await assert.rejects(f.source.load(f.owner, updated.value[1]), { code: "calendar_source_unavailable" });
});

test("duplicate identifiers retain the first matching planning and the source's first sorted order", t => {
  const f = fixture(t);
  f.plan("duplicate-plan", [post("duplicate-item", 1, "2099-01-02", "duplicate-order")], { cycle: "2099-01" });
  f.plan("duplicate-plan", [post("duplicate-item", 1, "2099-02-02", "duplicate-order")],
    { cycle: "2099-02", destination: "story", layout: "second-planning-layout" });
  const old = f.order("duplicate-order", "duplicate-plan", "duplicate-item", {
    cycle: "2099-01", caption: "First global order caption", bytes: Buffer.from("old artwork") });
  const newest = f.order("duplicate-order", "duplicate-plan", "duplicate-item", {
    cycle: "2099-02", caption: "Newest sorted order caption", bytes: Buffer.from("newest private artwork") });
  const firstPlan = planning.findPlanningById({ baseDir: f.planningDir, whatsapp: f.owner, planningId: "duplicate-plan" });
  const firstGlobal = orders.getPedidoBaseGlobal(f.ordersDir, "duplicate-order");
  const globalCaption = orders.readOrder(firstGlobal).descricao_instagram;
  assert.notEqual(old.base, newest.base);
  const listed = query(f, () => f.source.list(f.owner)); singleOwnerScan(f, listed);
  assert.equal(listed.value.length, 2);
  const newestStat = fs.statSync(path.join(newest.base, "resultado_final.png"));
  for (const item of listed.value) {
    assert.equal(item.destination, firstPlan.instagram_destination);
    assert.equal(item.layout, firstPlan.instagram_layout);
    assert.equal(item.caption, globalCaption, "global child lookup keeps its existing first occurrence");
    assert.equal(item.version, `${newestStat.size}:${newestStat.mtimeMs}`,
      "source result keeps the first matching order in descending creation order");
  }
  assert.equal(f.source.describe(f.owner, listed.value[0]).file,
    fs.realpathSync(path.join(newest.base, "resultado_final.png")));
  f.json(path.join(newest.base, "pedido.json"), { ...newest.pedido, pagamento_pendente: true });
  assert.throws(() => f.source.describe(f.owner, listed.value[0]), { code: "calendar_source_unavailable" },
    "an invalid first match must not fall through to a different duplicate");
  const revoked = query(f, () => f.source.list(f.owner)); singleOwnerScan(f, revoked);
  assert.ok(revoked.value.every(item => !item.imageReady));
});
