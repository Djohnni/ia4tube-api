"use strict";

const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const ISSUER = "ia4tube-api";
const AUDIENCE = "ia4tube-client";

function validOwner(owner) {
  return typeof owner === "string" && owner.length >= 1 && owner.length <= 200 &&
    owner !== "." && owner !== ".." && !/[\/\\?#\u0000-\u0020\u007f]/.test(owner);
}

function createProductionSession({ secret, readClients }) {
  if (typeof secret !== "string" || secret.length < 32 || typeof readClients !== "function") {
    throw new TypeError("Configuracao de sessao social invalida.");
  }
  function sign(owner) {
    if (!validOwner(owner)) throw new TypeError("Identidade de sessao invalida.");
    // The product still has exactly one owner per company. Never use a company
    // submitted by an HTTP client or silently upgrade a legacy signed token.
    return jwt.sign({ whatsapp: owner, sub: owner, company_id: owner, token_version: 2 },
      secret, { algorithm: "HS256", expiresIn: "7d", issuer: ISSUER,
        audience: AUDIENCE, jwtid: crypto.randomUUID() });
  }
  function authenticate(req, res, next) {
    try {
      const header = req.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 4096) throw new Error();
      const claims = jwt.verify(header.slice(7), secret, {
        algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE
      });
      if (claims.token_version !== 2 || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
          !validOwner(claims.whatsapp) || claims.sub !== claims.whatsapp ||
          claims.company_id !== claims.sub || typeof claims.jti !== "string" ||
          claims.jti.length < 16 || claims.jti.length > 200) throw new Error();
      const clients = readClients();
      const client = Object.hasOwn(clients, claims.whatsapp) ? clients[claims.whatsapp] : null;
      if (!client || client.ativo !== true ||
          (client.cadastro_automatico === true && client.conta_finalizada !== true)) throw new Error();
      req.user = Object.freeze(claims);
      return next();
    } catch {
      return res.status(401).json({ ok: false, code: "social_session_login_required" });
    }
  }
  return Object.freeze({ sign, authenticate });
}

module.exports = { AUDIENCE, ISSUER, createProductionSession };
