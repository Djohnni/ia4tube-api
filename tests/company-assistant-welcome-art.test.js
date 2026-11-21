"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const sharp = require("sharp");
const express = require("express");
const { createAssistantService } = require("../src/company-assistant/service");
const { createAssistantRouter } = require("../src/company-assistant/router");
const { createWelcomeArt } = require("../src/company-assistant/welcome-art");
const { createPromoRollout } = require("../src/billing/promo-rollout");
const { createProductionSession } = require("../src/social/production-session");

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

test("only an active authenticated session on the configured Android version enrolls, once per account across restarts", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-welcome-enrollment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { IA4TUBE_WELCOME_ART_ENABLED: "true", IA4TUBE_WELCOME_ART_TEST_VERSION: "117",
    IA4TUBE_PROMO_INTERNAL_ACCOUNTS: "old-test-owner" };
  const enrollment = { internalWelcomeRoot: path.join(root, "enrollment") };
  const rollout = createPromoRollout(env, enrollment);
  const clients = { alpha: { ativo: true }, beta: { ativo: true }, public: { ativo: true },
    inactive: { ativo: false }, unfinished: { ativo: true, cadastro_automatico: true, conta_finalizada: false } };
  const session = createProductionSession({ secret: "synthetic-welcome-test-secret-not-a-live-key", readClients: () => clients });
  const app = express();
  const service = createAssistantService({ root: path.join(root, "chat"), welcomeArtRoot: path.join(root, "art"),
    welcomeArtFor: rollout.welcomeArtFor, enrollWelcomeArtFor: rollout.enrollWelcomeArtFor,
    readClient: id => clients[id], apiKey: "synthetic-test-key", profile: { get: () => ({}) },
    calendar: { availability: async () => ({ availability: { canImage: false } }) }, observeConnection: async () => null });
  app.use(createAssistantRouter({ authenticate: session.authenticate, service }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  async function state(id, version) {
    const headers = {};
    if (id) headers.Authorization = `Bearer ${session.sign(id)}`;
    if (version) headers["X-IA4tube-Android-Version"] = version;
    const response = await fetch(url, { headers });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await state(null, "117")).status, 401);
  assert.equal((await state("inactive", "117")).status, 401);
  assert.equal((await state("unfinished", "117")).status, 401);
  for (const version of [undefined, "113", "117, 117", "119"]) {
    const publicState = await state("public", version);
    assert.equal(publicState.status, 200);
    assert.equal(Object.hasOwn(publicState.data, "preview"), false);
  }
  assert.equal(fs.existsSync(enrollment.internalWelcomeRoot), false);
  for (const id of ["alpha", "beta"]) {
    assert.equal((await state(id, "117")).data.preview.status, "available");
    assert.equal((await state(id, "117")).data.preview.status, "available");
  }
  const markers = fs.readdirSync(enrollment.internalWelcomeRoot);
  assert.equal(markers.length, 2);
  assert.ok(markers.every(marker => /^[a-f0-9]{64}$/.test(marker)));
  const restarted = createPromoRollout(env, enrollment);
  for (const id of ["alpha", "beta"]) {
    assert.equal(restarted.welcomeArtFor(id), true);
    assert.equal(restarted.storyPackageFor(id).quantity, 5);
  }
  assert.equal(restarted.welcomeArtFor("public"), false);
  assert.equal(restarted.welcomeArtFor("old-test-owner"), true);
  assert.equal(restarted.storyPackageFor("old-test-owner").quantity, 10);
  assert.equal(createPromoRollout({ ...env, IA4TUBE_WELCOME_ART_TEST_VERSION: "" }, enrollment).welcomeArtFor("alpha"), false);
});

test("a failure to save promotion enrollment leaves the regular chat available", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-enrollment-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const badRoot = path.join(root, "not-a-directory");
  fs.writeFileSync(badRoot, "blocked");
  const rollout = createPromoRollout({ IA4TUBE_WELCOME_ART_ENABLED: "true", IA4TUBE_WELCOME_ART_TEST_VERSION: "117" },
    { internalWelcomeRoot: badRoot });
  const service = createAssistantService({ root: path.join(root, "chat"), welcomeArtRoot: path.join(root, "art"),
    welcomeArtFor: rollout.welcomeArtFor, enrollWelcomeArtFor: rollout.enrollWelcomeArtFor,
    readClient: () => ({ ativo: true }), profile: { get: () => ({}) },
    calendar: { availability: async () => ({ availability: { canImage: false } }) }, observeConnection: async () => null });
  const state = await service.state(claims, { androidVersion: "117" });
  assert.equal(state.ok, true);
  assert.equal(Object.hasOwn(state, "preview"), false);
});

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
