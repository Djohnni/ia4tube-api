"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), sharp = require("sharp");
const { createAssistantService } = require("../src/company-assistant/service");
const billing = require("../src/billing/billing.service"), plans = require("../src/billing/plans");
const NOW = Date.parse("2099-01-16T12:00:00Z");
const WHATSAPP = "47900112233", GOOGLE = "google_synthetic_customer";
const claims = owner => ({ whatsapp: owner, sub: owner, company_id: owner, token_version: 2 });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const uuid = () => crypto.randomUUID();

async function fixture(t, { paid = false, enabled = true, connected = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "i4-chat-access-"));
  const clients = Object.fromEntries([WHATSAPP, GOOGLE].map(owner => {
    const client = { ativo: true };
    if (paid) billing.applyManualPlanPayment(client, plans.getPlan("i4_combo_10i_4v_v1"), {
      paymentId: "synthetic-" + owner, paidAt: "2099-01-15T12:00:00Z"
    });
    return [owner, client];
  }));
  const providerCalls = [], calendarCalls = [];
  let output = { reply: "Envie uma foto para preparar sua publicação.", photoDescriptions: [], items: [] };
  const png = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#ffaa22" } }).png().toBuffer();
  const service = createAssistantService({ root, clock: () => NOW, enabled, apiKey: "synthetic",
    readClient: owner => clients[owner],
    profile: { get: () => ({ profile: { has_logo: true } }), logo: () => png },
    observeConnection: async () => ({ state: connected ? "connected" : "disconnected", health: "healthy" }),
    calendar: {
      availability: async () => ({ availability: { canImage: false, canVideo: false } }),
      assistantTrialRemaining: async () => 0,
      createContext: async () => { calendarCalls.push("unexpected"); throw Error("no calendar call expected"); }
    },
    fetchImpl: async (_url, options) => {
      providerCalls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ status: "completed", usage: { input_tokens: 500, output_tokens: 100 },
        output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }] }) };
    },
    submitFetch: async () => { throw Error("no production call expected"); }
  });
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, root, clients, png, providerCalls, calendarCalls, setOutput: value => { output = value; } };
}

for (const owner of [WHATSAPP, GOOGLE]) for (const paid of [false, true]) {
  test(`${owner}: active ${paid ? "paid" : "unpaid"} account can chat with its own allowance and unchanged balance`, async t => {
    const f = await fixture(t, { paid }), before = structuredClone(f.clients);
    const state = await f.service.state(claims(owner));
    assert.equal(state.ok, true);
    assert.equal(state.messageLimit, paid ? 120 : 20);
    assert.equal(state.images, paid ? 10 : 0);
    assert.equal(state.videos, paid ? 4 : 0);
    const result = await f.service.message(claims(owner), { requestId: uuid(), message: "Como preparo minha publicação?", photoIds: [] });
    assert.equal(result.messagesUsed, 1);
    assert.equal(result.messages.at(-1).role, "assistant");
    assert.equal(f.providerCalls.length, 1);
    const other = await f.service.state(claims(owner === GOOGLE ? WHATSAPP : GOOGLE));
    assert.equal(other.messagesUsed, 0);
    assert.deepEqual(other.messages, []);
    assert.deepEqual(f.clients, before);
    assert.equal(f.calendarCalls.length, 0);
  });
}

test("unauthenticated, inactive, unknown and mismatched accounts never reach the provider", async t => {
  const f = await fixture(t);
  f.clients[GOOGLE].ativo = false;
  for (const session of [null, {}, claims("unknown"), claims(GOOGLE),
    { ...claims(WHATSAPP), company_id: GOOGLE }, { ...claims(WHATSAPP), token_version: 1 }]) {
    await assert.rejects(f.service.message(session, { requestId: uuid(), message: "Olá", photoIds: [] }), { code: "assistant_session_required" });
  }
  assert.equal(f.providerCalls.length, 0);
  assert.equal(fs.readdirSync(f.root).length, 0);
});

test("the existing assistant shutdown switch still refuses both account types", async t => {
  const f = await fixture(t, { enabled: false });
  for (const owner of [WHATSAPP, GOOGLE]) await assert.rejects(f.service.state(claims(owner)), { code: "assistant_unavailable" });
  assert.equal(f.providerCalls.length, 0);
});

test("photos and messages from one valid account are invisible to the other valid account", async t => {
  const f = await fixture(t), photoId = uuid();
  await f.service.upload(claims(GOOGLE), photoId, f.png, "foto-google.png");
  await f.service.message(claims(GOOGLE), { requestId: uuid(), message: "Minha mensagem privada", photoIds: [photoId] });
  assert.throws(() => f.service.photo(claims(WHATSAPP), photoId), { code: "assistant_photo_not_found" });
  await assert.rejects(f.service.message(claims(WHATSAPP), { requestId: uuid(), message: "Outra conta", photoIds: [photoId] }), { code: "assistant_photo_not_found" });
  const state = await f.service.state(claims(WHATSAPP));
  assert.deepEqual(state.photos, []); assert.deepEqual(state.messages, []);
  assert.equal(f.providerCalls.length, 1);
});

test("a Google account's exhausted conversation or budget cannot spend another provider call", async t => {
  for (const limit of ["messages", "usd"]) {
    const f = await fixture(t);
    await f.service.message(claims(GOOGLE), { requestId: uuid(), message: "Olá", photoIds: [] });
    const file = path.join(f.root, hash("assistant-v1\0" + GOOGLE), "state.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")), counter = Object.values(saved.counters)[0];
    counter[limit] = limit === "messages" ? 20 : 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    await assert.rejects(f.service.message(claims(GOOGLE), { requestId: uuid(), message: "Mais uma", photoIds: [] }), { code: "assistant_conversation_limit" });
    assert.equal(f.providerCalls.length, 1);
    assert.equal((await f.service.state(claims(WHATSAPP))).messagesUsed, 0);
  }
});

test("Google rate limiting remains independent from the WhatsApp account", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 6; n++) await f.service.message(claims(GOOGLE), { requestId: uuid(), message: "Planejar", photoIds: [] });
  await assert.rejects(f.service.message(claims(GOOGLE), { requestId: uuid(), message: "Sétima", photoIds: [] }), { code: "assistant_rate_limit" });
  await f.service.message(claims(WHATSAPP), { requestId: uuid(), message: "Primeira", photoIds: [] });
  assert.equal(f.providerCalls.length, 7);
});

for (const owner of [WHATSAPP, GOOGLE]) test(`${owner}: depleted media balance blocks confirmation before touching the calendar`, async t => {
  const f = await fixture(t, { paid: true, connected: true }), photoId = uuid();
  await f.service.upload(claims(owner), photoId, f.png, "foto.png");
  f.setOutput({ reply: "Preparei sua publicação.", photoDescriptions: [], items: [{ photoId, kind: "image", title: "Oferta", caption: "Oferta",
    imageText: null, segment: "Loja", date: "2099-01-17", time: "18:00", destination: "both" }] });
  const snapshot = await f.service.message(claims(owner), { requestId: uuid(), message: "Prepare uma imagem", photoIds: [photoId] });
  const client = f.clients[owner];
  client.artes_mensais_restantes = 0; client.videos_mensais_restantes = 0; client.artes_avulsas_restantes = 0;
  const before = structuredClone(f.clients);
  for (const kind of ["image", "video"]) {
    const body = { draftId: snapshot.draft.id, version: snapshot.draft.version, confirmed: true,
      items: snapshot.draft.items.map(({ id, date, time, destination }) => ({ id, date, time, destination, kind })) };
    await assert.rejects(f.service.confirm(claims(owner), body), { code: "assistant_balance_required" });
  }
  assert.equal(f.calendarCalls.length, 0);
  assert.deepEqual(f.clients, before);
});
