"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const sharp = require("sharp"), { createImageCaptionService, finalCaption, MODEL } = require("../src/company-edit-calendar/image-caption");
const { fail } = require("../src/company-edit-calendar/admission-contract");
const response = (text = "Seu pedido merece esse sabor!") => new Response(JSON.stringify({ status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 } }), { status: 200 });
async function fixture(t, options = {}) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, "ia4tube-caption-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith("ia4tube-caption-test-")); fs.rmSync(resolved, { recursive: true, force: true });
  });
  const id = crypto.randomUUID(), ticket = id + "." + "A".repeat(43);
  const row = { id, owner: "synthetic-owner", expiresAt: Date.now() + 86400000, phase: "pending" };
  let active = true, balance = 20, calls = 0;
  const input = { requestId: id, ticket, guidance: "Destaque o sabor #MinhaMarca #ComboDaCasa" };
  const file = { path: path.join(root, "input.png"), mimetype: "image/png" };
  await sharp({ create: { width: 300, height: 400, channels: 3, background: "orange" } }).png().toFile(file.path);
  const ports = { enabled: true, root, directories: () => {}, apiKey: "synthetic-key-never-live",
    ticketContext: value => { if (value !== ticket) fail("context_unavailable", 404); return structuredClone(row); },
    ownerClient: () => { if (!active) fail("session_required", 401); }, remainingImages: async () => balance,
    fetchImpl: async (url, request) => { calls++; return options.fetch ? options.fetch(url, request) : response(); } };
  return { root, row, input, file, service: createImageCaptionService(ports), ports,
    calls: () => calls, balance: value => { balance = value; }, active: value => { active = value; } };
}

test("one image plus guidance produces a caption, preserves requested hashtags and leaves balance unchanged", async t => {
  const f = await fixture(t, { fetch: async (url, req) => {
    assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(req.redirect, "error");
    const body = JSON.parse(req.body); assert.equal(body.model, MODEL); assert.equal(body.store, false);
    assert.equal(body.input[0].content[1].type, "input_image");
    assert.ok(body.input[0].content[1].image_url.startsWith("data:image/jpeg;base64,"));
    assert.ok(body.input[0].content[0].text.includes("#MinhaMarca")); return response();
  } });
  const result = await f.service.generate(f.input, f.file);
  assert.deepEqual(result, { ok: true, requestId: f.row.id, caption: "Seu pedido merece esse sabor!\n\n#MinhaMarca #ComboDaCasa" });
  assert.equal(f.calls(), 1);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, "image-captions", `${f.row.id}.json`)));
  assert.equal(record.automaticRetry, false); assert.equal(record.apiCalls, 1);
  assert.equal(JSON.stringify(record).includes("synthetic-key-never-live"), false);
  assert.equal(JSON.stringify(record).includes(f.input.ticket), false);
});

test("caption assistance for a video uses video quota with no image quota and never debits either",async t=>{
 const f=await fixture(t);f.balance(0);f.input.mediaKind='video';let reads=0;
 const service=createImageCaptionService({...f.ports,remainingVideos:async()=>{reads++;return 1}});
 const result=await service.generate(f.input,f.file);assert.ok(result.caption);assert.equal(reads,1);assert.equal(f.calls(),1);
 await service.generate(f.input,f.file);assert.equal(reads,1);assert.equal(f.calls(),1);
});

test("empty guidance is supported; manual caption assistance never creates an extra image reservation", async t => {
  const f = await fixture(t); f.input.guidance = "";
  assert.equal((await f.service.generate(f.input, f.file)).caption, "Seu pedido merece esse sabor!");
  assert.equal(f.row.admission, undefined); assert.equal(f.row.binding, undefined);
});

test("restart/lost confirmation after original or branded admission reuses the same caption with no available quota", async t => {
  const f = await fixture(t), first = await f.service.generate(f.input, f.file);
  Object.assign(f.row, { expiresAt: 1, admission: { mediaKind: "image" }, binding: { kind: "branded" } }); f.balance(0);
  const restarted = createImageCaptionService({ ...f.ports, apiKey: undefined, fetchImpl: () => assert.fail("no second API call") });
  assert.deepEqual(await restarted.generate(f.input, f.file), first); assert.equal(f.calls(), 1);
  assert.equal(restarted.verifyCapability(f.input.ticket).length, 64);
});

test("a changed direction/photo cannot replace a generated caption for the same upload", async t => {
  const f = await fixture(t); await f.service.generate(f.input, f.file);
  await assert.rejects(f.service.generate({ ...f.input, guidance: "Outra direção" }, f.file), { code: "edit_calendar_order_conflict" });
  await sharp({ create: { width: 400, height: 400, channels: 3, background: "blue" } }).png().toFile(f.file.path);
  await assert.rejects(f.service.generate(f.input, f.file), { code: "edit_calendar_order_conflict" }); assert.equal(f.calls(), 1);
});

for (const failure of ["network", "429", "incomplete", "empty"])
  test(`caption ${failure} never auto-retries or substitutes the user's directions as a final caption`, async t => {
    const f = await fixture(t, { fetch: async () => {
      if (failure === "network") throw Error("offline");
      if (failure === "429") return new Response("unavailable", { status: 429 });
      if (failure === "empty") return response("");
      return new Response(JSON.stringify({ status: "incomplete", output: [] }), { status: 200 });
    } });
    await assert.rejects(f.service.generate(f.input, f.file), { code: "edit_calendar_image_caption_preserved" });
    await assert.rejects(f.service.generate(f.input, f.file), { code: "edit_calendar_image_caption_preserved" });
    assert.equal(f.calls(), 1); assert.equal(f.service.canEdit(f.input.ticket), false);
  });

test("concurrent duplicate captions make only one request", async t => {
  let start, done; const began = new Promise(resolve => { start = resolve; }), wait = new Promise(resolve => { done = resolve; });
  const f = await fixture(t, { fetch: async () => { start(); await wait; return response(); } });
  const first = f.service.generate(f.input, f.file); await began;
  try { await assert.rejects(f.service.generate(f.input, f.file), { code: "edit_calendar_image_caption_preserved" }); }
  finally { done(); }
  await first; assert.equal(f.calls(), 1);
});

test("inactive/forged/expired/already-admitted contexts and missing quota cannot spend on caption generation", async t => {
  const f = await fixture(t); f.balance(0);
  await assert.rejects(f.service.generate(f.input, f.file), { code: "billing_required" });
  f.balance(20); f.active(false);
  await assert.rejects(f.service.generate(f.input, f.file), { code: "edit_calendar_session_required" });
  f.active(true);
  await assert.rejects(f.service.generate({ ...f.input, ticket: f.input.ticket.slice(0, -1) + "B" }, f.file), { code: "edit_calendar_context_unavailable" });
  f.row.expiresAt = 1;
  await assert.rejects(f.service.generate(f.input, f.file), { code: "edit_calendar_context_unavailable" });
  f.row.expiresAt = Date.now() + 86400000; f.row.admission = {};
  await assert.rejects(f.service.generate(f.input, f.file), { code: "edit_calendar_context_unavailable" });
  assert.equal(f.calls(), 0);
});

test("invalid image before any caption intent permits correcting the same draft", async t => {
  const f = await fixture(t); fs.writeFileSync(f.file.path, "not an image");
  await assert.rejects(f.service.generate(f.input, f.file), { code: "edit_calendar_ready_image_invalid" });
  assert.equal(f.service.canEdit(f.input.ticket), true); assert.equal(f.calls(), 0);
});

test("hashtags are not repeated and brand/user text is preserved without an extra API review", () => {
  assert.equal(finalCaption("Conheça a iA4tube! #MinhaMarca", "Use #MinhaMarca"), "Conheça a iA4tube! #MinhaMarca");
  assert.equal(finalCaption("Uma legenda.", "#ação #Cliente_2026"), "Uma legenda.\n\n#ação #Cliente_2026");
  assert.equal(finalCaption("Confira! #ComboDaCasa", "#Combo"), "Confira! #ComboDaCasa\n\n#Combo");
});
