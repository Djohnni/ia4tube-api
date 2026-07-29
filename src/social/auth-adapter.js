"use strict";

const { postgresFail } = require("../persistence/postgres/errors");
const { deriveSocialIdentity } = require("./identity");
const {
  SESSION_AUDIENCE,
  SESSION_ISSUER
} = require("./reauth");

function audienceMatches(audience) {
  return audience === SESSION_AUDIENCE ||
    (Array.isArray(audience) && audience.length === 1 &&
      audience[0] === SESSION_AUDIENCE);
}

function createSocialAuthAdapter(identityConfig = {}) {
  function fromVerifiedJwt(claims = {}) {
    if (
      claims.token_version !== 2 ||
      claims.iss !== SESSION_ISSUER ||
      !audienceMatches(claims.aud) ||
      typeof claims.jti !== "string" ||
      claims.jti.length < 16 ||
      claims.jti.length > 200 ||
      typeof claims.sub !== "string" ||
      claims.sub.length < 1 ||
      claims.sub.length > 500 ||
      claims.sub !== claims.whatsapp ||
      claims.sub !== claims.company_id
    ) {
      postgresFail(
        "social_authenticated_principal_invalid",
        "Principal autenticado recusado."
      );
    }
    const identity = deriveSocialIdentity({
      namespaceUuid: identityConfig.namespaceUuid,
      derivationKey: identityConfig.key,
      derivationVersion: identityConfig.derivationVersion,
      legacyCompanyId: claims.company_id,
      legacyUserId: claims.sub
    });
    return Object.freeze({
      tokenVersion: claims.token_version,
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      subject: claims.sub,
      jti: claims.jti,
      companyId: identity.companyId,
      userId: identity.userId,
      derivationVersion: identity.derivationVersion
    });
  }

  return Object.freeze({ fromVerifiedJwt });
}

module.exports = {
  audienceMatches,
  createSocialAuthAdapter
};
