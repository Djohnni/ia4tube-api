"use strict";
const crypto = require("node:crypto");
const { validBinding, fail, UUID } = require("./model");
const verified = new WeakSet();
const submissions = new WeakSet();
function isVerifiedCalendarGrant(grant) { return Boolean(grant && verified.has(grant)); }
function isVerifiedCalendarSubmission(grant) { return Boolean(grant && submissions.has(grant)); }
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
        !validBinding(grant.binding) || !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt > clock() ||
        !Number.isSafeInteger(grant.validUntil) || grant.validUntil <= clock()) return null;
    if (grant.sourceKind === "upload") {
      if (grant.planningId !== null || grant.quantity !== 1 || !UUID.test(grant.assetId || "") ||
          !Number.isSafeInteger(grant.assetRevision) || grant.assetRevision < 1 ||
          !/^[a-f0-9]{64}$/.test(grant.previewDigest || "") || !/^[a-f0-9]{40}$/.test(grant.jobId || "") ||
          !Number.isSafeInteger(grant.preferenceRevision) || grant.preferenceRevision < 1 ||
          grant.validUntil > grant.issuedAt + 180 * 86400000) return null;
    } else if ((grant.sourceKind !== undefined && grant.sourceKind !== "order") ||
        typeof grant.planningId !== "string" || !Number.isSafeInteger(grant.quantity) ||
        grant.quantity < 1 || grant.quantity > 40) return null;
    if (grant.jobId != null && !/^[a-f0-9]{40}$/.test(grant.jobId)) return null;
    Object.freeze(grant.binding); Object.freeze(grant); verified.add(grant); return grant;
  }
  function issueImport({ companyId, userId, binding, revision, assetId, assetRevision, previewDigest, jobId, validUntil = null }) {
    if (!UUID.test(companyId || "") || !UUID.test(userId || "") || !validBinding(binding) ||
        !Number.isSafeInteger(revision) || revision < 1 || !UUID.test(assetId || "") ||
        !Number.isSafeInteger(assetRevision) || assetRevision < 1 || !/^[a-f0-9]{64}$/.test(previewDigest || "") ||
        !/^[a-f0-9]{40}$/.test(jobId || "")) fail("calendar_consent_invalid", 400);
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) fail("calendar_consent_invalid", 400);
    if (validUntil !== null && (!Number.isSafeInteger(validUntil) || validUntil <= now || validUntil > now + 180 * 86400000)) fail("calendar_consent_invalid", 400);
    const value = { purpose: "calendar_publish", sourceKind: "upload", companyId, userId, binding,
      preferenceRevision: revision, planningId: null, quantity: 1, jobId, assetId, assetRevision,
      previewDigest, issuedAt: now, validUntil: validUntil ?? now + 180 * 86400000, nonce: crypto.randomUUID() };
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${sign(body)}`;
  }
  function issueSubmission({ companyId, userId, submissionId, requestHash, binding = null, revision = null }) {
    const now = clock();
    const value = { purpose: "calendar_import_submission", companyId, userId, submissionId, requestHash,
      binding, preferenceRevision: revision, issuedAt: now, validUntil: now + 180 * 86400000, nonce: crypto.randomUUID() };
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    const envelope = `${body}.${sign(body)}`;
    if (!verifySubmission(envelope, companyId, userId)) fail("calendar_consent_invalid", 400);
    return envelope;
  }
  function verifySubmission(envelope, companyId, userId) {
    if (typeof envelope !== "string" || envelope.length > 2048) return null;
    const [body, mac, extra] = envelope.split(".");
    if (extra || !/^[a-f0-9]{64}$/.test(mac || "") || !crypto.timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(sign(body), "hex"))) return null;
    let value; try { value = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
    if (value.purpose !== "calendar_import_submission" || value.companyId !== companyId || value.userId !== userId ||
        !UUID.test(companyId || "") || !UUID.test(userId || "") || !/^[a-f0-9]{40}$/.test(value.submissionId || "") ||
        !/^[a-f0-9]{64}$/.test(value.requestHash || "") || !Number.isSafeInteger(value.issuedAt) || value.issuedAt > clock() ||
        !Number.isSafeInteger(value.validUntil) || value.validUntil <= clock() || value.validUntil > value.issuedAt + 180 * 86400000 ||
        (value.binding === null ? value.preferenceRevision !== null : !validBinding(value.binding) ||
          !Number.isSafeInteger(value.preferenceRevision) || value.preferenceRevision < 1)) return null;
    if (value.binding) Object.freeze(value.binding);
    Object.freeze(value); submissions.add(value); return value;
  }
  return Object.freeze({ issue, issueImport, verify, issueSubmission, verifySubmission, close() { key.fill(0); } });
}
module.exports = { createCalendarGrants, isVerifiedCalendarGrant, isVerifiedCalendarSubmission };
