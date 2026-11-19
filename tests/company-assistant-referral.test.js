"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const sharp = require("sharp");
const { createAssistantService } = require("../src/company-assistant/service");
const { createReferralPartnerDirectory } = require("../src/company-assistant/referral-partners");

const NOW = Date.parse("2099-01-16T12:00:00Z");
const GOOGLE = "google_new";
const WHATSAPP = "5551999990000";
const EXISTING = "google_existing";
const PARTNERS = Array.from({ length: 6 }, (_, index) => ({
  name: `Parceiro ${index + 1}`,
  handle: `@parceiro_${index + 1}`
}));

const claims = owner => ({ whatsapp: owner, company_id: owner, token_version: 2, sub: owner });
const request = (message, photoIds = []) => ({ requestId: randomUUID(), message, photoIds });
const lastText = snapshot => snapshot.messages.at(-1)?.text;
const referralFile = (root, owner) => path.join(root, "referrals",
  createHash("sha256").update("assistant-v1\0" + owner).digest("hex") + ".json");
const readReferral = (root, owner) => JSON.parse(fs.readFileSync(referralFile(root, owner), "utf8"));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "i4-assistant-referral-"));
  const clients = {
    [GOOGLE]: { ativo: true, assistant_referral_eligible: true },
    [WHATSAPP]: { ativo: true, assistant_referral_eligible: true },
    [EXISTING]: { ativo: true }
  };
  const providerCalls = [];
  const services = [];
  function start(referralPartners, apiKey, listReferralPartners = () => referralPartners) {
    const service = createAssistantService({
      root, apiKey, listReferralPartners,
      clock: () => NOW,
      readClient: owner => clients[owner],
      profile: { get: () => ({ profile: { ramo: "Hamburgueria" } }) },
      observeConnection: async () => ({ state: "connected", health: "healthy" }),
      calendar: {
        availability: async () => ({ availability: { canImage: true } }),
        createContext: () => assert.fail("Opening the referral must not create a calendar order")
      },
      async fetchImpl(url, options) {
        const [context, ...photos] = JSON.parse(options.body).input[0].content;
        const parsed = JSON.parse(context.text);
        providerCalls.push({ context: parsed, photos });
        const photoId = parsed.selectedPhotos[0];
        const answer = {
          reply: "Preparei sua publicação.",
          photoDescriptions: [{ photoId, description: "Lanche sobre uma mesa." }],
          items: [{ photoId, kind: "image", title: "Oferta", caption: "Confira nossa oferta!", imageText: "R$ 29,90",
            segment: "Hamburgueria", visualInstructions: "Fundo de lanchonete.", date: "2099-01-17", time: "18:00", destination: "both" }]
        };
        return { ok: true, json: async () => ({ status: "completed", usage: { input_tokens: 100, output_tokens: 80 },
          output: [{ content: [{ type: "output_text", text: JSON.stringify(answer) }] }] }) };
      }
    });
    services.push(service);
    return service;
  }
  t.after(() => {
    for (const service of services) service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, clients, providerCalls, start };
}

test("a partner saved in the panel is offered in the next first chat, without changing an earlier list", async t => {
  const { root, start } = fixture(t);
  const directory = createReferralPartnerDirectory({ root, initialPartners: PARTNERS.slice(0, 5) });
  const service = start([], undefined, directory.list);
  const earlier = await service.state(claims(GOOGLE));
  assert.doesNotMatch(lastText(earlier), /Mais nomes/);

  directory.add(PARTNERS[5]);
  assert.deepEqual((await service.state(claims(GOOGLE))).messages, earlier.messages);
  const fresh = await service.state(claims(WHATSAPP));
  assert.match(lastText(fresh), /Mais nomes/);
  const secondPage = await service.message(claims(WHATSAPP), request("Mais nomes"));
  assert.match(lastText(secondPage), /6\. Parceiro 6 · @parceiro_6/);
  await service.message(claims(WHATSAPP), request("6"));
  assert.deepEqual(readReferral(root, WHATSAPP).attribution, { ...PARTNERS[5], at: NOW });
});

test("a new account sees the one stored option without spending quota or creating an order folder", async t => {
  const { root, providerCalls, start } = fixture(t);
  const service = start(PARTNERS.slice(0, 1));
  const existing = await service.state(claims(EXISTING));
  assert.deepEqual(existing.messages, []);
  assert.deepEqual((await start([]).state(claims(WHATSAPP))).messages, []);
  assert.deepEqual(fs.readdirSync(root), []);

  const fresh = await service.state(claims(GOOGLE));
  assert.equal(fresh.messages.length, 1);
  assert.match(lastText(fresh), /1\. Parceiro 1 · @parceiro_1/);
  assert.match(lastText(fresh), /Pular/);
  assert.doesNotMatch(lastText(fresh), /Mais nomes/);
  assert.deepEqual((await service.state(claims(GOOGLE))).messages, fresh.messages);
  assert.equal(service.report(claims(GOOGLE), { messageId: fresh.messages[0].id }).ok, true);
  assert.throws(() => service.report(claims(EXISTING), { messageId: fresh.messages[0].id }), { code: "assistant_input_invalid" });

  const selected = await service.message(claims(GOOGLE), request("@PARCEIRO_1"));
  assert.match(lastText(selected), /Indicação registrada para Parceiro 1/);
  assert.equal(selected.messagesUsed, 0);
  assert.equal(selected.images, fresh.images);
  assert.equal(selected.videos, fresh.videos);
  assert.deepEqual(selected.campaigns, []);
  assert.equal(selected.draft, null);
  assert.deepEqual(readReferral(root, GOOGLE).attribution, { ...PARTNERS[0], at: NOW });
  assert.deepEqual(fs.readdirSync(root), ["referrals"]);
  assert.deepEqual(providerCalls, []);
});

test("pagination, retries and skipping stay stable across sessions and isolated by account", async t => {
  const { root, clients, providerCalls, start } = fixture(t);
  const service = start(PARTNERS);
  const first = await service.state(claims(GOOGLE));
  assert.equal((lastText(first).match(/@parceiro_/g) || []).length, 5);
  assert.match(lastText(first), /Mais nomes/);
  assert.doesNotMatch(lastText(first), /@parceiro_6/);
  const other = await service.state(claims(WHATSAPP));
  const next = request("Mais nomes");
  const second = await service.message(claims(GOOGLE), next);
  assert.match(lastText(second), /6\. Parceiro 6 · @parceiro_6/);
  assert.doesNotMatch(lastText(second), /@parceiro_[1-5]|Mais nomes/);
  assert.deepEqual((await service.message(claims(GOOGLE), next)).messages, second.messages);
  await assert.rejects(service.message(claims(GOOGLE), { ...next, message: "Pular" }), { code: "assistant_request_conflict" });
  assert.deepEqual((await service.state(claims(WHATSAPP))).messages, other.messages);

  service.close();
  const reopened = start([{ name: "Outra lista", handle: "@outra_lista" }]);
  assert.deepEqual((await reopened.state(claims(GOOGLE))).messages, second.messages);
  const select = request("6");
  const selected = await reopened.message(claims(GOOGLE), select);
  assert.deepEqual((await reopened.message(claims(GOOGLE), select)).messages, selected.messages);
  assert.deepEqual(readReferral(root, GOOGLE).attribution, { ...PARTNERS[5], at: NOW });

  const skipped = await reopened.message(claims(WHATSAPP), request("Pular"));
  assert.match(lastText(skipped), /Como posso ajudar/);
  assert.deepEqual((await reopened.state(claims(WHATSAPP))).messages, skipped.messages);
  assert.equal(readReferral(root, WHATSAPP).outcome, "skipped");
  assert.equal(readReferral(root, WHATSAPP).attribution, undefined);
  assert.equal(selected.messagesUsed, 0);
  assert.equal(skipped.messagesUsed, 0);
  assert.equal(clients[GOOGLE].assistant_referral_eligible, true);
  assert.deepEqual(providerCalls, []);
});

test("sending a photo stays in the usual creative flow even when the text is a referral command", async t => {
  const { root, providerCalls, start } = fixture(t);
  const service = start(PARTNERS, "fake-test-key");
  await service.state(claims(GOOGLE));
  const photoId = randomUUID();
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "orange" } }).png().toBuffer();
  await service.upload(claims(GOOGLE), photoId, png, "combo.png");
  const creative = await service.message(claims(GOOGLE), request("1", [photoId]));
  assert.equal(creative.draft.items[0].imageText, "R$ 29,90");
  assert.equal(creative.messagesUsed, 1);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0].context.selectedPhotos, [photoId]);
  assert.equal(providerCalls[0].photos.filter(part => part.type === "input_image").length, 1);
  assert.doesNotMatch(JSON.stringify(providerCalls[0].context), /@parceiro_|Quem indicou/);
  assert.equal(readReferral(root, GOOGLE).attribution, undefined);
});
