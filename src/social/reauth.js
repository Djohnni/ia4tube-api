"use strict";

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { postgresFail } = require("../persistence/postgres/errors");
const {
  requireProvider,
  requireUuid
} = require("../persistence/postgres/validation");
const { REAUTH_ACTIONS } = require(
  "../persistence/postgres/social-repository"
);

const REAUTH_TTL_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;
const SESSION_ISSUER = "ia4tube-api";
const SESSION_AUDIENCE = "ia4tube-client";

class SocialReauthError extends Error {
  constructor(code, message = "Reautenticacao social recusada.") {
    super(message);
    this.name = "SocialReauthError";
    this.code = code;
  }
}

function reauthFail(code) {
  throw new SocialReauthError(code);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireAction(action) {
  if (!REAUTH_ACTIONS.has(action)) reauthFail("reauth_action_invalid");
  return action;
}

function requireSession(session = {}) {
  if (
    session.tokenVersion !== 2 ||
    session.issuer !== SESSION_ISSUER ||
    session.audience !== SESSION_AUDIENCE ||
    typeof session.subject !== "string" ||
    session.subject.length < 1 ||
    session.subject.length > 500 ||
    typeof session.jti !== "string" ||
    session.jti.length < 16 ||
    session.jti.length > 200
  ) {
    reauthFail("reauth_session_invalid");
  }
  return Object.freeze({
    companyId: requireUuid(session.companyId, "company_id"),
    userId: requireUuid(session.userId, "user_id"),
    jti: session.jti,
    subject: session.subject
  });
}

function requireTarget(input = {}) {
  const action = requireAction(input.action);
  const provider = requireProvider(input.provider);
  const targetConnectionId = input.targetConnectionId
    ? requireUuid(input.targetConnectionId, "target_connection_id")
    : null;
  if (
    (action === "social.connect" && targetConnectionId) ||
    (action !== "social.connect" && !targetConnectionId)
  ) {
    reauthFail("reauth_target_invalid");
  }
  return Object.freeze({ action, provider, targetConnectionId });
}

function createSocialReauthService(options = {}) {
  const repository = options.repository;
  const comparePassword = options.comparePassword || bcrypt.compare;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const randomUuid = options.randomUuid || crypto.randomUUID;
  const clock = options.clock || (() => new Date());
  if (
    !repository ||
    typeof repository.findReauthIdentity !== "function" ||
    typeof repository.createReauthGrant !== "function" ||
    typeof repository.consumeReauthGrant !== "function"
  ) {
    postgresFail(
      "reauth_repository_required",
      "Repositorio de reautenticacao obrigatorio."
    );
  }

  async function issue(input = {}) {
    const session = requireSession(input.session);
    const target = requireTarget(input);
    if (
      typeof input.password !== "string" ||
      input.password.length < 1 ||
      input.password.length > 1024
    ) {
      reauthFail("reauth_credentials_invalid");
    }
    const identity = await repository.findReauthIdentity({
      companyId: session.companyId,
      userId: session.userId
    });
    if (
      !identity ||
      typeof identity.password_hash !== "string" ||
      identity.password_hash.length < 20 ||
      !Number.isSafeInteger(Number(identity.auth_version)) ||
      Number(identity.auth_version) < 1 ||
      !["owner", "admin"].includes(identity.role)
    ) {
      reauthFail("reauth_credentials_invalid");
    }
    let valid = false;
    try {
      valid = await comparePassword(input.password, identity.password_hash);
    } catch {
      reauthFail("reauth_credentials_invalid");
    }
    if (!valid) reauthFail("reauth_credentials_invalid");

    const now = clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      reauthFail("reauth_clock_invalid");
    }
    const raw = randomBytes(TOKEN_BYTES);
    if (!Buffer.isBuffer(raw) || raw.length !== TOKEN_BYTES) {
      reauthFail("reauth_random_invalid");
    }
    const token = raw.toString("base64url");
    raw.fill(0);
    const expiresAt = new Date(now.getTime() + REAUTH_TTL_MS);
    await repository.createReauthGrant({
      companyId: session.companyId,
      id: randomUuid(),
      userId: session.userId,
      tokenDigest: sha256(token),
      sessionJtiDigest: sha256(session.jti),
      action: target.action,
      provider: target.provider,
      targetConnectionId: target.targetConnectionId,
      authVersion: Number(identity.auth_version),
      expiresAt
    });
    return Object.freeze({ token, expiresAt });
  }

  async function consume(input = {}) {
    const session = requireSession(input.session);
    const target = requireTarget(input);
    if (
      typeof input.token !== "string" ||
      input.token.length < 40 ||
      input.token.length > 100 ||
      !/^[A-Za-z0-9_-]+$/.test(input.token)
    ) {
      reauthFail("reauth_grant_invalid");
    }
    const consumed = await repository.consumeReauthGrant({
      companyId: session.companyId,
      userId: session.userId,
      tokenDigest: sha256(input.token),
      sessionJtiDigest: sha256(session.jti),
      action: target.action,
      provider: target.provider,
      targetConnectionId: target.targetConnectionId
    });
    if (!consumed) reauthFail("reauth_grant_invalid");
    return Object.freeze({
      authorized: true,
      action: target.action,
      consumedAt: consumed.consumed_at
    });
  }

  return Object.freeze({ consume, issue });
}

module.exports = {
  REAUTH_TTL_MS,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  SocialReauthError,
  TOKEN_BYTES,
  createSocialReauthService,
  requireSession,
  requireTarget,
  sha256
};
