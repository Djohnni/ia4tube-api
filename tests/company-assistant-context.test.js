"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { ensureCreativeContext, appendContextMessages, contextMessages, closeCreativeContext } = require("../src/company-assistant/creative-context");

function legacy() {
  return { messages: [
    { id: "a", role: "user", text: "X-tudo 39,32", photoIds: ["old-photo"] },
    { id: "b", role: "assistant", text: "Proposta anterior" },
    { id: "c", role: "user", text: "Arte completa 41,41", photoIds: ["new-photo"] },
    { id: "d", role: "assistant", text: "Proposta atual" }
  ], attempts: { a: { at: 1 }, c: { at: 3 } }, campaigns: [{ id: "confirmed", afterMessageId: "b", createdAt: 2 }],
  photos: [{ id: "old-photo", description: "X-tudo" }, { id: "new-photo", description: "Cached old label" }],
  draft: { items: [{ photoId: "new-photo" }] }, assistanceTopic: "creation" };
}

test("legacy confirmed order closes the creative history but preserves a newer unconfirmed proposal", () => {
  const state = legacy(), original = structuredClone(state), context = ensureCreativeContext(state);
  assert.deepEqual(contextMessages(state).map(m => m.id), ["c", "d"]);
  assert.deepEqual(context.photoIds, ["new-photo"]);
  assert.deepEqual(context.lastPhotoIds, ["new-photo"]);
  assert.deepEqual(context.photoDescriptions, {});
  for (const key of ["messages", "photos", "attempts", "campaigns", "draft"]) assert.deepEqual(state[key], original[key]);
});

test("trimmed legacy receipt only admits a definitely newer user attempt", () => {
  const state = legacy(); state.messages = state.messages.filter(m => m.id !== "b");
  assert.deepEqual(ensureCreativeContext(state).messageIds, ["c", "d"]);
  const uncertain = legacy(); uncertain.messages = uncertain.messages.slice(0, 1); uncertain.draft = null;
  assert.deepEqual(ensureCreativeContext(uncertain).messageIds, []);
  assert.deepEqual(uncertain.creativeContext.photoIds, []);
  assert.equal(uncertain.assistanceTopic, undefined);
});

test("initial unconfirmed legacy preparation keeps its messages and draft photos without old cached labels", () => {
  const state = legacy(); state.campaigns = [];
  assert.deepEqual(ensureCreativeContext(state).messageIds, ["a", "b", "c", "d"]);
  assert.deepEqual(state.creativeContext.photoDescriptions, {});
});

test("confirmation boundary survives history trimming and keeps all historical orders and photos", () => {
  const state = legacy(), originalPhotos = structuredClone(state.photos), originalOrders = structuredClone(state.campaigns);
  ensureCreativeContext(state); closeCreativeContext(state, "next-order"); state.draft = null;
  for (let i = 0; i < 90; i++) appendContextMessages(state, { id: "new-" + i, role: "user", text: "Current", photoIds: [] });
  assert.equal(contextMessages(state).length, 80);
  assert(!JSON.stringify(contextMessages(state)).includes("X-tudo"));
  assert.deepEqual(state.photos, originalPhotos); assert.deepEqual(state.campaigns, originalOrders);
});
