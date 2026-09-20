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
  ownerCompanyId, ownerUserId, workerId, finance, maxExistenceSeconds = 7200, admissionSeconds = null } = {}) {
  if (![packageSha256, packageReviewSha256, authorizationSha256].every(v => HASH.test(v || "")) ||
      ![ownerCompanyId, ownerUserId].every(v => OWNER_UUID.test(v || "")) || !UUID.test(workerId || "")) fail("plan_binding_invalid");
  const extended = maxExistenceSeconds === 14400;
  if (maxExistenceSeconds !== 7200 && !extended) fail("window_invalid");
  const profile = extended ? { admission: 12000, cleanup: 1200, drain: 1200, hours: 4 } :
    { admission: 5400, cleanup: 600, drain: 600, hours: 2 };
  if (admissionSeconds === null) admissionSeconds = profile.admission;
  if (!Number.isSafeInteger(admissionSeconds) || admissionSeconds < 600 || admissionSeconds > profile.admission ||
      admissionSeconds + profile.drain > maxExistenceSeconds - profile.cleanup) fail("window_invalid");
  const legacyKeys = "alreadyIncurredUsd,buildAdditionalUsd,computeHourlyUsd,diskGiBHourlyUsd,egressAllowanceGiB,egressUsdPerGiB,ipv4HourlyUsd,otherAllowanceUsd,pilotReferenceUsd,pricingEvidenceSha256,verifiedAt";
  const extendedKeys = "alreadyIncurredObservedAt,alreadyIncurredUsd,buildAdditionalUsd,computeHourlyUsd,diskGiBHourlyUsd,egressAllowanceGiB,egressUsdPerGiB,historicalPlanningReserveUsd,historicalReserveIsObservedExpense,ipv4HourlyUsd,otherAllowanceUsd,pilotReferenceUsd,pricingEvidenceSha256,verifiedAt";
  if (!finance || Object.keys(finance).sort().join() !== (extended ? extendedKeys : legacyKeys) ||
      !HASH.test(finance.pricingEvidenceSha256 || "") || !Number.isSafeInteger(finance.verifiedAt) || finance.verifiedAt < 1 ||
      finance.pilotReferenceUsd !== 5 || finance.buildAdditionalUsd !== 0 || finance.egressAllowanceGiB > 5) fail("finance_invalid");
  const numericKeys = ["buildAdditionalUsd", "computeHourlyUsd", "diskGiBHourlyUsd", "egressAllowanceGiB",
    "egressUsdPerGiB", "ipv4HourlyUsd", "otherAllowanceUsd", "pilotReferenceUsd"];
  if (numericKeys.some(k => !Number.isFinite(finance[k]) || finance[k] < 0)) fail("finance_invalid");
  if (extended) {
    if (finance.historicalReserveIsObservedExpense !== false || !Number.isFinite(finance.historicalPlanningReserveUsd) ||
        finance.historicalPlanningReserveUsd < 0 ||
        !(finance.alreadyIncurredUsd === null || Number.isFinite(finance.alreadyIncurredUsd) && finance.alreadyIncurredUsd >= 0) ||
        (finance.alreadyIncurredUsd === null) !== (finance.alreadyIncurredObservedAt === null) ||
        finance.alreadyIncurredObservedAt !== null && (!Number.isSafeInteger(finance.alreadyIncurredObservedAt) ||
          finance.alreadyIncurredObservedAt < 1 || finance.alreadyIncurredObservedAt > finance.verifiedAt)) fail("finance_invalid");
  } else if (!Number.isFinite(finance.alreadyIncurredUsd) || finance.alreadyIncurredUsd < 0) fail("finance_invalid");
  const estimatedInfrastructureUsd = profile.hours * (finance.computeHourlyUsd + 50 * finance.diskGiBHourlyUsd + finance.ipv4HourlyUsd);
  const estimatedMaximumUsd = estimatedInfrastructureUsd + finance.egressAllowanceGiB * finance.egressUsdPerGiB + finance.otherAllowanceUsd;
  const priorBudgetBasisUsd = extended ? Math.max(finance.alreadyIncurredUsd ?? 0, finance.historicalPlanningReserveUsd) : finance.alreadyIncurredUsd;
  const priorBudgetBasisKind = extended ? finance.alreadyIncurredUsd !== null && finance.alreadyIncurredUsd >= finance.historicalPlanningReserveUsd ?
    "measured_spend" : "planning_reserve" : "legacy_already_incurred";
  const estimatedPlanningTotalUsd = estimatedMaximumUsd + priorBudgetBasisUsd;
  if (estimatedMaximumUsd <= 0 || estimatedPlanningTotalUsd > finance.pilotReferenceUsd) fail("budget_exceeded");
  const infrastructure = createGooglePlan({ imageId, operatorIpv4,
    resolution: { packageSha256, packageReviewSha256, authorizationSha256 }, maxExistenceSeconds });
  validateGooglePlan(infrastructure, { executable: true });
  const value = { schema: extended ? 2 : 1, kind: "ia4tube-google-owner-operational-pilot", infrastructure,
    ownerCompanyId, ownerUserId, workerId, packageSha256, packageReviewSha256, authorizationSha256,
    maxExistenceSeconds, admissionSeconds, cleanupReserveSeconds: profile.cleanup, drainReserveSeconds: profile.drain,
    maxInstallInvocations: 1, maxWorkerStarts: 1, syntheticCases: 0, recurring: false,
    externalConnection: false, externalPublication: false, metaWindow: false,
    finance: { ...finance, estimatedInfrastructureUsd, estimatedMaximumUsd,
      ...(extended ? { priorBudgetBasisUsd, priorBudgetBasisKind, estimatedPlanningTotalUsd } : {}), invoiceCapGuaranteed: false } };
  return { ...value, approvalSha256: sha256(canonical(value)) };
}
function validateOperationalPlan(plan, { now = null } = {}) {
  const f = plan?.finance;
  const finance = f && Object.fromEntries(Object.entries(f).filter(([k]) => !["estimatedInfrastructureUsd", "estimatedMaximumUsd", "priorBudgetBasisUsd", "priorBudgetBasisKind", "estimatedPlanningTotalUsd", "invoiceCapGuaranteed"].includes(k)));
  const expected = createOperationalPlan({ imageId: plan?.infrastructure?.sourceImageId, operatorIpv4: plan?.infrastructure?.operatorIpv4,
    packageSha256: plan?.packageSha256, packageReviewSha256: plan?.packageReviewSha256, authorizationSha256: plan?.authorizationSha256,
    ownerCompanyId: plan?.ownerCompanyId, ownerUserId: plan?.ownerUserId, workerId: plan?.workerId, finance,
    maxExistenceSeconds: plan?.maxExistenceSeconds, admissionSeconds: plan?.admissionSeconds });
  if (canonical(plan) !== canonical(expected)) fail("plan_changed");
  if (now !== null && (f.verifiedAt > now || now - f.verifiedAt > 86400000)) fail("pricing_check_stale");
  return plan;
}
module.exports = { HASH, fail, createOperationalPlan, validateOperationalPlan };
