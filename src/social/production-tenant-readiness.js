"use strict";

const { isAuthenticatedSocialPrincipal } = require("./auth-adapter");

class ProductionTenantReadinessError extends Error {
  constructor(code) {
    super("Vinculo da empresa indisponivel.");
    this.name = "ProductionTenantReadinessError";
    this.code = code;
  }
}

function createProductionTenantReadiness({ authAdapter, companies } = {}) {
  if (typeof authAdapter?.fromVerifiedJwt !== "function" || typeof companies?.findActiveOwner !== "function") {
    throw new TypeError("Configuracao de vinculo da empresa invalida.");
  }

  async function assertReady(verifiedClaims) {
    let principal;
    try {
      // The caller MUST have verified signature/issuer/audience/expiry and the
      // current official product owner first. This adapter additionally binds
      // sub == whatsapp == company_id and brands the derived HMAC identity.
      principal = authAdapter.fromVerifiedJwt(verifiedClaims);
      if (!isAuthenticatedSocialPrincipal(principal)) throw new Error();
    } catch {
      throw new ProductionTenantReadinessError("social_session_login_required");
    }
    let owner;
    try {
      owner = await companies.findActiveOwner({ companyId: principal.companyId, userId: principal.userId });
    } catch {
      throw new ProductionTenantReadinessError("social_tenant_readiness_unavailable");
    }
    if (!owner) throw new ProductionTenantReadinessError("tenant_not_provisioned");
    if (owner.companyId !== principal.companyId || owner.userId !== principal.userId || owner.role !== "owner" ||
        owner.identityDerivationVersion !== principal.derivationVersion) {
      throw new ProductionTenantReadinessError("social_tenant_readiness_unavailable");
    }
    return principal;
  }

  async function middleware(req, res, next) {
    try {
      await assertReady(req.user);
      return next();
    } catch (error) {
      const code = error instanceof ProductionTenantReadinessError ? error.code : "social_tenant_readiness_unavailable";
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(code === "social_session_login_required" ? 401 : 503).json({ ok: false, code });
    }
  }
  return Object.freeze({ assertReady, middleware });
}

module.exports = { createProductionTenantReadiness };
