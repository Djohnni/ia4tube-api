"use strict";

// Server-owned eligibility, independent of Instagram gates and of a customer's
// request body. Multi-company execution remains blocked until the shared durable
// capacity coordinator is actually wired around both inspection and preparation.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const policies = new WeakSet();
function fail(code) { throw Object.assign(new Error(`calendar_import_access_${code}`), {
  code: `calendar_import_access_${code}`, statusCode: code === "configuration_invalid" ? 503 : 403
}); }
function createImportAccessPolicy({ mode = "owner_pilot", allowedOwners = [], isEligible = () => true } = {}) {
  if (!["owner_pilot", "multi_company"].includes(mode) || !Array.isArray(allowedOwners) ||
      allowedOwners.length > (mode === "owner_pilot" ? 1 : 1000) || typeof isEligible !== "function") fail("configuration_invalid");
  const seen = new Set(), companyAudiences = new Map();
  const owners = allowedOwners.map(value => {
    if (!value || !UUID.test(value.companyId || "") || !UUID.test(value.userId || "")) fail("configuration_invalid");
    const owner = { companyId: value.companyId.toLowerCase(), userId: value.userId.toLowerCase(),
      audience: value.audience ?? (mode === "owner_pilot" ? "owner_pilot" : null) };
    const key = `${owner.companyId}:${owner.userId}`;
    if (!["owner_pilot", "customers"].includes(owner.audience) || mode === "owner_pilot" && owner.audience !== "owner_pilot" ||
        seen.has(key) || companyAudiences.has(owner.companyId) && companyAudiences.get(owner.companyId) !== owner.audience) fail("configuration_invalid");
    seen.add(key); companyAudiences.set(owner.companyId, owner.audience);
    return Object.freeze(owner);
  });
  function resolve(context, { worker = false } = {}) {
    if (context?.authenticated !== true || !UUID.test(context.companyId || "") ||
        (worker ? context.role !== "calendar_media_worker" : !UUID.test(context.userId || ""))) fail("not_allowed");
    const companyId = context.companyId.toLowerCase(), userId = typeof context.userId === "string" ? context.userId.toLowerCase() : null;
    const owner = owners.find(value => value.companyId === companyId && (worker || value.userId === userId));
    if (!owner) fail("not_allowed");
    // A trusted callback may settle an already-started task after eligibility is
    // revoked. It cannot start work, expose a preview or schedule a publication.
    if (!worker) {
      let eligible = false;
      try {
        const decision = isEligible(Object.freeze({ ...owner }));
        // Configuration is deliberately synchronous for use inside an atomic
        // owner transaction. Drain a misconfigured Promise without accepting it.
        if (decision && typeof decision.then === "function") Promise.resolve(decision).catch(() => {});
        else eligible = decision === true;
      } catch (_) { /* fail closed */ }
      if (!eligible) fail("not_allowed");
    }
    return Object.freeze({ ...owner });
  }
  const policy = Object.freeze({ mode, configured: owners.length > 0,
    // Do not change this based only on a caller-supplied capabilities boolean.
    // reserve/acquire/settle must be wired before enabling customer dispatch.
    executionAvailable: mode === "owner_pilot" && owners.length === 1,
    resolve });
  policies.add(policy);
  return policy;
}
function isImportAccessPolicy(value) { return Boolean(value && policies.has(value)); }
module.exports = { createImportAccessPolicy, isImportAccessPolicy };
