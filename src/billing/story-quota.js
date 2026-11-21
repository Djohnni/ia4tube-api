"use strict";

const LEGACY_STORY_PACKAGE = Object.freeze({ id: "i4_stories_5_avulso_v1", title: "5 Stories", amount: 19.90, quantity: 5 });
const STORY_PACKAGE = Object.freeze({ id: "i4_stories_10_avulso_v1", title: "10 Stories", amount: 19.90, quantity: 10 });
const storyPackages = [LEGACY_STORY_PACKAGE, STORY_PACKAGE];
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
function getStoryPackage(id) {
  return storyPackages.find(pack => pack.id === id);
}
function state(client) {
  const s = client.stories_avulsos || { purchases: {}, uses: {} };
  if (!s || typeof s !== "object" || !s.purchases || !s.uses) fail("story_balance_invalid", 503);
  return s;
}
function remaining(client) {
  const s = state(client);
  const total = Object.values(s.purchases).reduce((n, p) => {
    if (!storyPackages.some(pack => pack.quantity === p.quantity)) fail("story_balance_invalid", 503);
    return n + p.quantity;
  }, 0);
  const used = Object.values(s.uses).filter(u => u.refunded !== true).length;
  if (used > total) fail("story_balance_invalid", 503);
  return total - used;
}
function credit(client, paymentId, purchaseId, at, productId = STORY_PACKAGE.id) {
  const pack = getStoryPackage(productId);
  if (!paymentId || !purchaseId || !pack) fail("story_payment_invalid");
  const s = structuredClone(state(client)), prior = s.purchases[String(paymentId)];
  if (prior) {
    if (prior.purchaseId !== purchaseId || prior.quantity !== pack.quantity) fail("story_payment_conflict");
    return false;
  }
  if (Object.values(s.purchases).some(p => p.purchaseId === purchaseId)) fail("story_payment_conflict");
  s.purchases[String(paymentId)] = { purchaseId, quantity: pack.quantity, at };
  client.stories_avulsos = s;
  return true;
}
function consume(client, planningId, at) {
  if (!planningId) fail("story_reservation_invalid");
  const s = structuredClone(state(client)), prior = s.uses[planningId];
  if (prior && !prior.refunded) return false;
  if (prior?.refunded) fail("story_reservation_cancelled");
  if (remaining(client) < 1) fail("billing_required", 402);
  s.uses[planningId] = { at, refunded: false };
  client.stories_avulsos = s;
  return true;
}
function refund(client, planningId, at) {
  const s = structuredClone(state(client)), prior = s.uses[planningId];
  if (!prior) fail("story_reservation_missing", 503);
  if (prior.refunded) return false;
  prior.refunded = true; prior.refundedAt = at;
  client.stories_avulsos = s;
  return true;
}
module.exports = { STORY_PACKAGE, LEGACY_STORY_PACKAGE, getStoryPackage, remaining, credit, consume, refund };
