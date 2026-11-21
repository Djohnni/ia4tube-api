"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const sharp = require("sharp");
const { createAssistantService } = require("../src/company-assistant/service");
const { createWelcomeArt } = require("../src/company-assistant/welcome-art");
const { createPromoRollout } = require("../src/billing/promo-rollout");

const owner = "synthetic-welcome-art-owner";
const claims = { whatsapp: owner, company_id: owner, token_version: 2 };
const uuid = () => crypto.randomUUID();

async function waitFor(predicate) {
  for (let n = 0; n < 150; n++) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail("Expected welcome art state did not arrive");
}

test("first free art can be downloaded without an Instagram, logo, calendar, or duplicate generation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-welcome-art-"));
  const photoId = uuid();
  const inputs = [];
  const png = await sharp({ create: { width: 70, height: 50, channels: 3, background: "red" } }).png().toBuffer();
  const rendered = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "green" } }).png().toBuffer();
  const internal = createPromoRollout({ IA4TUBE_PROMO_INTERNAL_ACCOUNTS: owner, IA4TUBE_WELCOME_ART_ENABLED: "true" });
  const client = { ativo: true };
  const parsedDraft = { reply: "Sua arte está preparada.", photoDescriptions: [],
    items: [{ photoId, kind: "image", title: "Oferta", caption: "", imageText: "R$ 39,90", segment: "Comércio",
      visualInstructions: "Destaque o produto com um fundo verde.", date: null, time: null, destination: "both" }] };
  const service = createAssistantService({
    root: path.join(root, "chat"), welcomeArtRoot: path.join(root, "private"),
    welcomeArtFor: internal.welcomeArtFor, storyPackageFor: internal.storyPackageFor,
    apiKey: "synthetic-test-key", readClient: key => key === owner ? client : { ativo: true },
    profile: { get: () => ({ profile: { has_logo: false } }), logo: () => assert.fail("logo not required") },
    calendar: { availability: async () => ({ availability: { canImage: false } }),
      createContext: () => assert.fail("calendar path invoked") },
    observeConnection: async () => null,
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify(parsedDraft) }] }],
      usage: { input_tokens: 400, output_tokens: 100 } }) }),
    welcomeArtFetch: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/images/edits");
      inputs.push(options.body);
      return new Response(JSON.stringify({ data: [{ b64_json: rendered.toString("base64") }] }));
    }
  });
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  service.start();
  const initial = await service.state(claims);
  assert.equal(initial.connected, false);
  assert.equal(initial.preview.status, "available");
  assert.equal(initial.images, 0);
  const other = { whatsapp: "other", company_id: "other", token_version: 2 };
  assert.equal(Object.hasOwn(await service.state(other), "preview"), false);
  assert.throws(() => service.preview(other), { code: "assistant_preview_unavailable" });
  for (const [session, quantity] of [[claims, 10], [other, 5]]) {
    const reply = await service.message(session, { requestId: uuid(), message: "Quanto custa o pacote de Stories?", photoIds: [] });
    assert.match(reply.messages.at(-1).text, new RegExp(`Temos ${quantity} imagens para Stories`));
  }
  await service.upload(claims, photoId, png, "foto.png");
  const state = await service.message(claims, { requestId: uuid(), message: "Crie uma oferta por R$ 39,90.", photoIds: [photoId], previewEnabled: true });
  assert.equal(state.draft.items[0].photoId, photoId);
  const request = { draftId: state.draft.id, revision: state.draft.version, photoId };
  assert.throws(() => service.startPreview(claims, { ...request, model: "override" }), { code: "assistant_input_invalid" });
  assert.equal(service.startPreview(claims, request).preview.status, "queued");
  service.startPreview(claims, request);
  await waitFor(() => service.preview(claims).preview.status === "ready");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].get("model"), "gpt-image-2.5-sunburst");
  assert.equal(inputs[0].get("quality"), "low");
  assert.equal(inputs[0].get("size"), "1024x1536");
  assert.match(inputs[0].get("prompt"), /R\$ 39,90/);
  assert.equal(inputs[0].getAll("image[]").length, 1);
  const chunks = [];
  for await (const chunk of service.previewImage(claims)) chunks.push(chunk);
  const dimensions = await sharp(Buffer.concat(chunks)).metadata();
  assert.equal(dimensions.width, 1024);
  assert.equal(dimensions.height, 1536);
  assert.equal(service.previewDownloaded(claims).preview.downloaded, true);
  assert.equal(service.previewDownloaded(claims).preview.downloaded, true);
  const refreshed = await service.state(claims);
  assert.equal(refreshed.preview.downloaded, true);
  assert.equal(refreshed.draft, null);
  assert.equal(refreshed.images, 0);
  assert.throws(() => service.previewImage(other), { code: "assistant_preview_unavailable" });
  assert.deepEqual(client, { ativo: true });
});

test("uncertain image generation is preserved across restart and makes no further charge attempt", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-welcome-failure-"));
  const key = "2".repeat(64);
  const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: "orange" } }).png().toBuffer();
  let calls = 0;
  const options = { root, apiKey: "synthetic-test-key", fetchImpl: async () => { calls++; throw new Error("network"); } };
  const worker = createWelcomeArt(options);
  const recovered = createWelcomeArt(options);
  t.after(() => { worker.close(); recovered.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const job = { owner, draftId: uuid(), revision: 1, photoId: uuid(), photos: [photo], instructions: "Texto sintético" };
  worker.reserve(key, job);
  worker.start();
  await waitFor(() => worker.state(key).status === "unavailable");
  worker.close();
  recovered.start();
  assert.equal(recovered.reserve(key, job).status, "unavailable");
  await delay(50);
  assert.equal(calls, 1);
});
