"use strict";

const STORY_PACKAGE = Object.freeze({ id: "i4_stories_5_avulso_v1", title: "5 Stories", amount: 19.90, quantity: 5 });
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
function state(client) {
  const s = client.stories_avulsos || { purchases: {}, uses: {} };
  if (!s || typeof s !== "object" || !s.purchases || !s.uses) fail("story_balance_invalid", 503);
  return s;
}
function remaining(client) {
  const s = state(client);
  const total = Object.values(s.purchases).reduce((n, p) => {
    if (p.quantity !== 5) fail("story_balance_invalid", 503);
    return n + p.quantity;
  }, 0);
  const used = Object.values(s.uses).filter(u => u.refunded !== true).length;
  if (used > total) fail("story_balance_invalid", 503);
  return total - used;
}
function credit(client, paymentId, purchaseId, at) {
  if (!paymentId || !purchaseId) fail("story_payment_invalid");
  const s = structuredClone(state(client)), prior = s.purchases[String(paymentId)];
  if (prior) {
    if (prior.purchaseId !== purchaseId) fail("story_payment_conflict");
    return false;
  }
  if (Object.values(s.purchases).some(p => p.purchaseId === purchaseId)) fail("story_payment_conflict");
  s.purchases[String(paymentId)] = { purchaseId, quantity: 5, at };
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
module.exports = { STORY_PACKAGE, remaining, credit, consume, refund };
