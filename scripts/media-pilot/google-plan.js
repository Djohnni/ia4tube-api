"use strict";
// A separate operational envelope. The immutable, already reviewed Google
// infrastructure contract is reused only for resource bodies/identity checks.
// No synthetic sequence is authorized or invoked by this envelope.
const { createGooglePlan, validateGooglePlan, UUID } = require("../validation/vm-proof-google-plan");
const { canonical, sha256 } = require("../validation/vm-proof-manifest");
const HASH = /^[a-f0-9]{64}$/;
// Product identities are derived UUIDv5. Mission/worker identities retain the
// narrower random UUIDv4 provider contract; do not recreate a product identity.
const OWNER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code) { throw Object.assign(new Error("media_pilot_" + code), { code: "media_pilot_" + code }); }
function createOperationalPlan({ imageId, operatorIpv4, packageSha256, packageReviewSha256, authorizationSha256,
  ownerCompanyId, ownerUserId, workerId, finance, admissionSeconds = 5400 } = {}) {
  if (![packageSha256, packageReviewSha256, authorizationSha256].every(v => HASH.test(v || "")) ||
      ![ownerCompanyId, ownerUserId].every(v => OWNER_UUID.test(v || "")) || !UUID.test(workerId || "")) fail("plan_binding_invalid");
  if (!Number.isSafeInteger(admissionSeconds) || admissionSeconds < 600 || admissionSeconds > 5400) fail("window_invalid");
  const keys = "alreadyIncurredUsd,buildAdditionalUsd,computeHourlyUsd,diskGiBHourlyUsd,egressAllowanceGiB,egressUsdPerGiB,ipv4HourlyUsd,otherAllowanceUsd,pilotReferenceUsd,pricingEvidenceSha256,verifiedAt";
  if (!finance || Object.keys(finance).sort().join() !== keys || !HASH.test(finance.pricingEvidenceSha256 || "") ||
      !Number.isSafeInteger(finance.verifiedAt) || finance.verifiedAt < 1 ||
      Object.entries(finance).some(([k,v]) => !["pricingEvidenceSha256", "verifiedAt"].includes(k) && (!Number.isFinite(v) || v < 0)) ||
      finance.pilotReferenceUsd !== 5 || finance.buildAdditionalUsd !== 0 || finance.egressAllowanceGiB > 5) fail("finance_invalid");
  const estimatedInfrastructureUsd = 2 * (finance.computeHourlyUsd + 50 * finance.diskGiBHourlyUsd + finance.ipv4HourlyUsd);
  const estimatedMaximumUsd = estimatedInfrastructureUsd + finance.egressAllowanceGiB * finance.egressUsdPerGiB + finance.otherAllowanceUsd;
  if (estimatedMaximumUsd <= 0 || estimatedMaximumUsd + finance.alreadyIncurredUsd > finance.pilotReferenceUsd) fail("budget_exceeded");
  const infrastructure = createGooglePlan({ imageId, operatorIpv4, resolution: { packageSha256, packageReviewSha256, authorizationSha256 } });
  validateGooglePlan(infrastructure, { executable: true });
  const value = { schema: 1, kind: "ia4tube-google-owner-operational-pilot", infrastructure,
    ownerCompanyId, ownerUserId, workerId, packageSha256, packageReviewSha256, authorizationSha256,
    maxExistenceSeconds: 7200, admissionSeconds, cleanupReserveSeconds: 600, drainReserveSeconds: 600,
    maxInstallInvocations: 1, maxWorkerStarts: 1, syntheticCases: 0, recurring: false,
    externalConnection: false, externalPublication: false, metaWindow: false,
    finance: { ...finance, estimatedInfrastructureUsd, estimatedMaximumUsd, invoiceCapGuaranteed: false } };
  return { ...value, approvalSha256: sha256(canonical(value)) };
}
function validateOperationalPlan(plan, { now = null } = {}) {
  const f = plan?.finance;
  const finance = f && Object.fromEntries(Object.entries(f).filter(([k]) => !["estimatedInfrastructureUsd", "estimatedMaximumUsd", "invoiceCapGuaranteed"].includes(k)));
  const expected = createOperationalPlan({ imageId: plan?.infrastructure?.sourceImageId, operatorIpv4: plan?.infrastructure?.operatorIpv4,
    packageSha256: plan?.packageSha256, packageReviewSha256: plan?.packageReviewSha256, authorizationSha256: plan?.authorizationSha256,
    ownerCompanyId: plan?.ownerCompanyId, ownerUserId: plan?.ownerUserId, workerId: plan?.workerId, finance, admissionSeconds: plan?.admissionSeconds });
  if (canonical(plan) !== canonical(expected)) fail("plan_changed");
  if (now !== null && (f.verifiedAt > now || now - f.verifiedAt > 86400000)) fail("pricing_check_stale");
  return plan;
}
module.exports = { HASH, fail, createOperationalPlan, validateOperationalPlan };
