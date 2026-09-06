"use strict";

const crypto = require("node:crypto");
const { isAuthenticatedSocialPrincipal } = require("./auth-adapter");
const { SESSION_AUDIENCE, SESSION_ISSUER } = require("./reauth");
const { requireKeyVersion, requireUuid } = require("../persistence/postgres/validation");

const OFFICIAL_OWNER_DIGEST_DOMAIN = "ia4tube-social-official-owner-v1";

class ProductionTenantBindingError extends Error {
  constructor(code) {
    super("Vinculo da empresa indisponivel.");
    this.name = "ProductionTenantBindingError";
    this.code = code;
  }
}

function fail(code) { throw new ProductionTenantBindingError(code); }

function officialOwnerBinding(principal, expectedDerivationVersion) {
  // A principal produced from OAuth state is deliberately insufficient. The
  // official session verifier must establish signature, expiry and active owner
  // before the trusted auth adapter constructs this JWT principal.
  if (!isAuthenticatedSocialPrincipal(principal) || principal.tokenVersion !== 2 ||
      principal.issuer !== SESSION_ISSUER || principal.audience !== SESSION_AUDIENCE ||
      typeof principal.subject !== "string" || principal.subject.length < 1) {
    fail("social_session_login_required");
  }
  let companyId, userId, derivationVersion;
  try {
    companyId = requireUuid(principal.companyId, "company_id");
    userId = requireUuid(principal.userId, "user_id");
    derivationVersion = requireKeyVersion(principal.derivationVersion);
    if (derivationVersion !== requireKeyVersion(expectedDerivationVersion)) throw new Error();
  } catch {
    fail("social_tenant_binding_conflict");
  }
  // The existing required users.login_key_digest stores an opaque identity
  // marker, NOT a password or an additional login. The SQL function derives the
  // same marker internally from these three parameters; no PII crosses to SQL.
  const loginKeyDigest = crypto.createHash("sha256").update([
    OFFICIAL_OWNER_DIGEST_DOMAIN, companyId, userId, derivationVersion
  ].join("\n"), "utf8").digest("hex");
  return Object.freeze({ companyId, userId, derivationVersion, loginKeyDigest });
}

module.exports = { OFFICIAL_OWNER_DIGEST_DOMAIN, ProductionTenantBindingError, officialOwnerBinding };
