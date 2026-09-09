"use strict";
const crypto = require("node:crypto");
const { validBinding, fail, UUID } = require("./model");
const verified = new WeakSet();
function isVerifiedCalendarGrant(grant) { return Boolean(grant && verified.has(grant)); }
function createCalendarGrants(secret, clock = Date.now) {
  const key = crypto.createHmac("sha256", secret).update("ia4tube-calendar-order-consent-v1").digest();
  const sign = body => crypto.createHmac("sha256", key).update(body).digest("hex");
  function issue({ companyId, userId, binding, revision, planningId, quantity, jobId = null }) {
    if (!UUID.test(companyId) || !UUID.test(userId) || !validBinding(binding) ||
        typeof planningId !== "string" || planningId.length < 5 || planningId.length > 150 ||
        !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 40) fail("calendar_consent_invalid", 400);
    if (jobId !== null && !/^[a-f0-9]{40}$/.test(jobId)) fail("calendar_consent_invalid", 400);
    const value = { purpose: "calendar_publish", companyId, userId, binding, preferenceRevision: revision, planningId, quantity, jobId,
      issuedAt: clock(), validUntil: clock() + 180 * 86400000, nonce: crypto.randomUUID() };
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${sign(body)}`;
  }
  function verify(envelope, companyId, userId) {
    if (typeof envelope !== "string" || envelope.length > 2048) return null;
    const [body, mac, extra] = envelope.split(".");
    if (extra || !/^[a-f0-9]{64}$/.test(mac || "") || !crypto.timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(sign(body), "hex"))) return null;
    let grant;
    try { grant = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
    if (grant.purpose !== "calendar_publish" || grant.companyId !== companyId || grant.userId !== userId ||
        !validBinding(grant.binding) || typeof grant.planningId !== "string" || !Number.isSafeInteger(grant.quantity) ||
        grant.quantity < 1 || grant.quantity > 40 || !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt > clock() ||
        !Number.isSafeInteger(grant.validUntil) || grant.validUntil <= clock()) return null;
    if (grant.jobId != null && !/^[a-f0-9]{40}$/.test(grant.jobId)) return null;
    Object.freeze(grant.binding); Object.freeze(grant); verified.add(grant); return grant;
  }
  return Object.freeze({ issue, verify, close() { key.fill(0); } });
}
module.exports = { createCalendarGrants, isVerifiedCalendarGrant };
