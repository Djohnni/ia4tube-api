"use strict";

const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const {
  SOCIAL_MIGRATOR_ROLE,
  SOCIAL_OWNER_ROLE,
  databaseTargetFingerprint,
  loadMigrationPostgresConfig,
  loadRuntimePostgresConfig
} = require("../src/persistence/postgres/config");
const { postgresFail } = require("../src/persistence/postgres/errors");
const {
  ADVISORY_LOCK_ID,
  createMigrationRunner
} = require("../src/persistence/postgres/migrations");
const {
  SET_COMPANY_SCOPE_SQL,
  closePostgresPool,
  createPostgresPool,
  withTransaction
} = require("../src/persistence/postgres/pool");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");
const {
  createConnectorContext
} = require("../src/social/connectors/contract");
const { inputDigest } = require("../src/social/connectors/service");
const {
  deriveSocialIdentity,
  parseIdentityConfig,
  uuidV5
} = require("../src/social/identity");
const {
  INSTAGRAM_OAUTH_SCOPES,
  loadInstagramOAuthConfig
} = require("../src/social/oauth/instagram-config");
const {
  INSTAGRAM_OAUTH_CREDENTIAL_TYPE
} = require("../src/social/oauth/instagram-oauth-service");
const { createSocialRuntime } = require("../src/social/runtime");
const {
  createSocialVault,
  parseVaultKeyring
} = require("../src/social/vault");

const GATE5A_STAGING_ORIGIN =
  "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const GATE5A_ENVIRONMENT = "staging";
const GATE5A_REVIEWER_LOGIN = "999000000000005";
const GATE5A_REVIEWER_COMPANY_NAME =
  "Sabor da Vila Hamburgueria — DEMO";
const GATE5A_SYNTHETIC_USERNAME = "empresa_exemplo";
const GATE5A_SYNTHETIC_DISPLAY_NAME =
  "Sabor da Vila Hamburgueria — DEMO";
const GATE5A_SYNTHETIC_ACCOUNT_TYPE = "business";
const GATE5A_SYNTHETIC_TOKEN_PREFIX =
  "ia4tube-gate5a-synthetic-token-v1:";
const GATE5A_REVIEWER_CLIENT_REQUEST_ID =
  "gate5a-reviewer-manual-publish-v1";
const GATE5A_BRIDGE_APPROVAL_PREFIX =
  "PROVISION_GATE5A_SYNTHETIC_BRIDGE:";
const IDENTITY_STATUS = "active";
const SAFE_ERROR_CODE = /^[a-z0-9_]{2,96}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIRMATION_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const REVIEWER_CONTENT_REFERENCE_PATTERN =
  /^gate5a-content:[0-9a-f]{64}:[0-9a-f]{32}$/;

function fail(code) {
  postgresFail(code, "Ponte sintetica Gate 5A recusada.");
}

function exactTrue(value) {
  return value === "true";
}

function gate5aSyntheticBridgeGateState(env = process.env) {
  const environment = env.ENVIRONMENT === GATE5A_ENVIRONMENT;
  const origin = env.PUBLIC_API_BASE_URL === GATE5A_STAGING_ORIGIN;
  const reviewSandbox = exactTrue(env.REVIEW_SANDBOX_ENABLED);
  const syntheticProvider = exactTrue(env.SYNTHETIC_PROVIDER_ENABLED);
  return Object.freeze({
    enabled: environment && origin && reviewSandbox && syntheticProvider,
    environment,
    origin,
    reviewSandbox,
    syntheticProvider
  });
}

function gate5aReviewerSurfaceGateState(env = process.env) {
  const bridge = gate5aSyntheticBridgeGateState(env);
  const legacyTestOnly =
    env.ENVIRONMENT === undefined &&
    env.NODE_ENV === "test" &&
    env.PUBLIC_API_BASE_URL === GATE5A_STAGING_ORIGIN &&
    env.SOCIAL_PERSISTENCE_ENABLED === "false";
  return Object.freeze({
    enabled: bridge.enabled || legacyTestOnly,
    persistent: bridge.enabled,
    legacyTestOnly
  });
}

function requireGate5aSyntheticBridgeEnabled(env) {
  const gates = gate5aSyntheticBridgeGateState(env);
  if (!gates.enabled) fail("gate5a_synthetic_bridge_gate_required");
  return gates;
}

function expectedTargetFingerprint() {
  const target = PAID_STAGING_PUBLIC_TARGET;
  return databaseTargetFingerprint(
    new URL(
      `postgresql://${target.migrationLogin}@${target.host}:` +
        `${target.port}/${target.database}`
    )
  );
}

const GATE5A_STAGING_TARGET_FINGERPRINT = expectedTargetFingerprint();

function exactProvisionApproval(environmentId, fingerprint, companyId) {
  if (!UUID_PATTERN.test(String(companyId || ""))) {
    fail("gate5a_synthetic_identity_invalid");
  }
  return (
    `${GATE5A_BRIDGE_APPROVAL_PREFIX}${environmentId}:` +
    `${fingerprint}:${GATE5A_REVIEWER_LOGIN}:${companyId}`
  );
}

function deterministicExternalUserId(companyId) {
  if (!UUID_PATTERN.test(String(companyId || ""))) {
    fail("gate5a_synthetic_identity_invalid");
  }
  const digest = crypto
    .createHash("sha256")
    .update("ia4tube-gate5a-synthetic-external-user-v1\0", "utf8")
    .update(companyId, "ascii")
    .digest();
  try {
    const value = BigInt(`0x${digest.subarray(0, 26).toString("hex")}`);
    return (value === 0n ? 1n : value).toString(10);
  } finally {
    digest.fill(0);
  }
}

function deriveGate5aSyntheticIdentity(env, legacyId = GATE5A_REVIEWER_LOGIN) {
  if (legacyId !== GATE5A_REVIEWER_LOGIN) {
    fail("gate5a_synthetic_reviewer_identity_mismatch");
  }
  const identityConfig = parseIdentityConfig(env);
  try {
    const identity = deriveSocialIdentity({
      namespaceUuid: identityConfig.namespaceUuid,
      derivationKey: identityConfig.key,
      derivationVersion: identityConfig.derivationVersion,
      legacyCompanyId: legacyId,
      legacyUserId: legacyId
    });
    return Object.freeze({
      ...identity,
      connectionId: uuidV5(
        identity.companyId,
        "ia4tube:gate5a:synthetic-bridge:connection:v1"
      ),
      credentialId: uuidV5(
        identity.companyId,
        "ia4tube:gate5a:synthetic-bridge:credential:v1"
      ),
      correlationId: uuidV5(
        identity.userId,
        "ia4tube:gate5a:synthetic-bridge:correlation:v1"
      ),
      auditEventId: uuidV5(
        identity.userId,
        "ia4tube:gate5a:synthetic-bridge:audit:v1"
      ),
      externalUserId: deterministicExternalUserId(identity.companyId),
      loginKeyDigest: crypto
        .createHash("sha256")
        .update("ia4tube-gate5a-social-login-v1\0", "utf8")
        .update(legacyId, "utf8")
        .digest("hex")
    });
  } finally {
    identityConfig.key.fill(0);
  }
}

function gate5aReviewerPublicationIdentity(identity) {
  if (!UUID_PATTERN.test(String(identity?.companyId || ""))) {
    fail("gate5a_synthetic_identity_invalid");
  }
  return Object.freeze({
    operationId: uuidV5(
      identity.companyId,
      `ia4tube:gate5a:reviewer-operation:v1:${GATE5A_REVIEWER_CLIENT_REQUEST_ID}`
    ),
    publicationId: uuidV5(
      identity.companyId,
      `ia4tube:gate5a:reviewer-publication:v1:${GATE5A_REVIEWER_CLIENT_REQUEST_ID}`
    ),
    mediaId: `synthetic-media-${uuidV5(
      identity.companyId,
      "ia4tube:gate5a:reviewer-media:v1"
    )}`,
    reference: `synthetic-review:${uuidV5(
      identity.companyId,
      "ia4tube:gate5a:reviewer-reference:v1"
    )}`
  });
}

function gate5aReviewerPublicationContent(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== "caption,mediaReference" ||
    !REVIEWER_CONTENT_REFERENCE_PATTERN.test(
      String(value.mediaReference || "")
    ) ||
    typeof value.caption !== "string" ||
    value.caption.length < 1 ||
    value.caption.length > 2200 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.caption)
  ) {
    fail("gate5a_synthetic_history_content_invalid");
  }
  return Object.freeze({
    caption: value.caption,
    mediaReference: value.mediaReference
  });
}

function gate5aReviewerPublicationPayload(identity, content) {
  const ids = gate5aReviewerPublicationIdentity(identity);
  const trustedContent = gate5aReviewerPublicationContent(content);
  const payload = Object.freeze({
    operationId: ids.operationId,
    publicationId: ids.publicationId,
    connectionId: identity.connectionId,
    image: Object.freeze({
      mediaId: trustedContent.mediaReference,
      mimeType: "image/jpeg"
    }),
    caption: trustedContent.caption
  });
  return Object.freeze({
    ids,
    payload,
    requestHash: inputDigest(payload),
    mediaMetadataDigest: crypto
      .createHash("sha256")
      .update(JSON.stringify(payload.image), "utf8")
      .digest("hex")
  });
}

function gate5aReviewerStatusUrl(confirmationCode) {
  if (!CONFIRMATION_CODE_PATTERN.test(String(confirmationCode || ""))) {
    fail("gate5a_synthetic_deletion_unconfirmed");
  }
  return `${GATE5A_STAGING_ORIGIN}/v1/social/compliance/meta/` +
    `data-deletion/status/${encodeURIComponent(confirmationCode)}`;
}

function runtimeEnvironment(env) {
  const clean = { ...env };
  delete clean.SOCIAL_MIGRATIONS_DATABASE_URL;
  delete clean.GATE5A_REVIEWER_PASSWORD;
  delete clean.GATE5A_SYNTHETIC_BRIDGE_APPROVED;
  clean.SOCIAL_INSTAGRAM_EXPECTED_USERNAME = GATE5A_SYNTHETIC_USERNAME;
  clean.SOCIAL_EXTERNAL_PUBLICATION_ENABLED = "false";
  return clean;
}

function migrationEnvironment(env) {
  const clean = { ...env };
  delete clean.DATABASE_URL;
  delete clean.GATE5A_REVIEWER_PASSWORD;
  return clean;
}

function validateMigrationTarget(config, env, identity) {
  const target = PAID_STAGING_PUBLIC_TARGET;
  if (
    config.target.environment !== GATE5A_ENVIRONMENT ||
    config.target.environmentId !== target.environmentId ||
    config.target.host !== target.host ||
    config.target.port !== target.port ||
    config.target.database !== target.database ||
    config.target.username !== target.migrationLogin ||
    config.targetFingerprint !== GATE5A_STAGING_TARGET_FINGERPRINT ||
    config.ownerRole !== SOCIAL_OWNER_ROLE ||
    config.migratorRole !== SOCIAL_MIGRATOR_ROLE ||
    config.pool.max !== 1 ||
    config.pool.min !== 0 ||
    config.pool.ssl?.rejectUnauthorized !== true
  ) {
    fail("gate5a_synthetic_bridge_target_mismatch");
  }
  if (
    env.GATE5A_SYNTHETIC_BRIDGE_APPROVED !==
    exactProvisionApproval(
      target.environmentId,
      config.targetFingerprint,
      identity?.companyId
    )
  ) {
    fail("gate5a_synthetic_bridge_approval_invalid");
  }
  return true;
}

function validateRuntimeTarget(config) {
  const target = PAID_STAGING_PUBLIC_TARGET;
  if (
    !config?.enabled ||
    config.targetFingerprint !== GATE5A_STAGING_TARGET_FINGERPRINT ||
    config.login !== target.runtimeLogin ||
    config.role !== "ia4tube_social_runtime" ||
    config.pool?.ssl?.rejectUnauthorized !== true
  ) {
    fail("gate5a_synthetic_bridge_target_mismatch");
  }
  return true;
}

function exactCompany(row, identity) {
  return Boolean(
    row &&
    row.id === identity.companyId &&
    row.name === GATE5A_REVIEWER_COMPANY_NAME &&
    row.status === IDENTITY_STATUS &&
    row.identity_derivation_version === identity.derivationVersion
  );
}

function exactUser(row, identity) {
  return Boolean(
    row &&
    row.company_id === identity.companyId &&
    row.id === identity.userId &&
    row.login_key_digest === identity.loginKeyDigest &&
    row.password_hash === null &&
    row.status === IDENTITY_STATUS &&
    Number(row.auth_version) === 1
  );
}

function exactMembership(row, identity) {
  return Boolean(
    row &&
    row.company_id === identity.companyId &&
    row.user_id === identity.userId &&
    row.role === "owner" &&
    row.status === IDENTITY_STATUS
  );
}

async function insertOrVerifyIdentity(client, identity) {
  const counts = { inserted: 0, alreadyExact: 0 };
  await client.query(SET_COMPANY_SCOPE_SQL, [identity.companyId]);

  const companyInsert = await client.query(
    [
      "INSERT INTO ia4tube_social.companies (",
      " id,name,status,identity_derivation_version",
      ") VALUES ($1,$2,'active',$3)",
      "ON CONFLICT DO NOTHING RETURNING id"
    ].join("\n"),
    [
      identity.companyId,
      GATE5A_REVIEWER_COMPANY_NAME,
      identity.derivationVersion
    ]
  );
  const company = await client.query(
    [
      "SELECT id,name,status,identity_derivation_version",
      "FROM ia4tube_social.companies WHERE id=$1"
    ].join("\n"),
    [identity.companyId]
  );
  if (company.rowCount !== 1 || !exactCompany(company.rows[0], identity)) {
    fail("gate5a_synthetic_company_drift_detected");
  }
  if (companyInsert.rowCount === 1) counts.inserted += 1;
  else counts.alreadyExact += 1;

  const userInsert = await client.query(
    [
      "INSERT INTO ia4tube_social.users (",
      " company_id,id,login_key_digest,password_hash,status,auth_version",
      ") VALUES ($1,$2,$3,NULL,'active',1)",
      "ON CONFLICT DO NOTHING RETURNING id"
    ].join("\n"),
    [identity.companyId, identity.userId, identity.loginKeyDigest]
  );
  const user = await client.query(
    [
      "SELECT company_id,id,login_key_digest,password_hash,status,auth_version",
      "FROM ia4tube_social.users WHERE company_id=$1 AND id=$2"
    ].join("\n"),
    [identity.companyId, identity.userId]
  );
  if (user.rowCount !== 1 || !exactUser(user.rows[0], identity)) {
    fail("gate5a_synthetic_user_drift_detected");
  }
  if (userInsert.rowCount === 1) counts.inserted += 1;
  else counts.alreadyExact += 1;

  const membershipInsert = await client.query(
    [
      "INSERT INTO ia4tube_social.company_memberships (",
      " company_id,user_id,role,status",
      ") VALUES ($1,$2,'owner','active')",
      "ON CONFLICT DO NOTHING RETURNING user_id"
    ].join("\n"),
    [identity.companyId, identity.userId]
  );
  const membership = await client.query(
    [
      "SELECT company_id,user_id,role,status",
      "FROM ia4tube_social.company_memberships",
      "WHERE company_id=$1 AND user_id=$2"
    ].join("\n"),
    [identity.companyId, identity.userId]
  );
  if (
    membership.rowCount !== 1 ||
    !exactMembership(membership.rows[0], identity)
  ) {
    fail("gate5a_synthetic_membership_drift_detected");
  }
  if (membershipInsert.rowCount === 1) counts.inserted += 1;
  else counts.alreadyExact += 1;

  return Object.freeze(counts);
}

async function bootstrapSyntheticIdentity(options) {
  const env = options.env;
  const identity = options.identity;
  const loadConfig = options.loadMigrationConfig || loadMigrationPostgresConfig;
  const createPool = options.createPool || createPostgresPool;
  const createRunner = options.createRunner || createMigrationRunner;
  const transact = options.transact || withTransaction;
  const closePool = options.closePool || closePostgresPool;
  const migrationEnv = migrationEnvironment(env);
  const config = loadConfig(migrationEnv);
  validateMigrationTarget(config, env, identity);

  let pool;
  let outcome;
  let operationError;
  try {
    pool = createPool(Object.freeze({ ...config.pool, max: 1, min: 0 }), {
      logger: options.logger,
      PoolClass: options.PoolClass
    });
    const runner = createRunner({
      pool,
      ownerRole: config.ownerRole,
      migratorRole: config.migratorRole,
      target: config.target,
      manifestOptions: options.manifestOptions
    });
    const migrationStatus = await runner.validate();
    if (
      migrationStatus?.valid !== true ||
      migrationStatus.pending !== 0 ||
      !Number.isSafeInteger(migrationStatus.applied) ||
      migrationStatus.applied !== 6
    ) {
      fail("gate5a_synthetic_bridge_schema_not_current");
    }
    outcome = await transact(
      pool,
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock($1::bigint)",
          [ADVISORY_LOCK_ID]
        );
        return insertOrVerifyIdentity(client, identity);
      },
      { role: SOCIAL_OWNER_ROLE }
    );
  } catch (error) {
    operationError = error;
  }
  if (pool) {
    try {
      await closePool(pool);
    } catch (error) {
      if (!operationError) operationError = error;
    }
  }
  if (operationError) throw operationError;
  return outcome;
}

function requireVerifiedReviewerClaims(claims) {
  if (
    !claims ||
    typeof claims !== "object" ||
    Array.isArray(claims) ||
    claims.token_version !== 2 ||
    claims.iss !== "ia4tube-api" ||
    claims.aud !== "ia4tube-client" ||
    typeof claims.jti !== "string" ||
    claims.jti.length < 16 ||
    claims.sub !== GATE5A_REVIEWER_LOGIN ||
    claims.whatsapp !== GATE5A_REVIEWER_LOGIN ||
    claims.company_id !== GATE5A_REVIEWER_LOGIN
  ) {
    fail("gate5a_synthetic_reviewer_identity_mismatch");
  }
  return claims;
}

function requireReviewerCompanyName(value) {
  if (value !== GATE5A_REVIEWER_COMPANY_NAME) {
    fail("gate5a_synthetic_reviewer_company_mismatch");
  }
  return value;
}

async function authenticateSyntheticReviewer(options) {
  const env = options.env;
  const transport = options.transport || globalThis.fetch;
  const password = env.GATE5A_REVIEWER_PASSWORD;
  try {
    delete env.GATE5A_REVIEWER_PASSWORD;
  } catch {}
  if (
    typeof password !== "string" ||
    password.length < 10 ||
    password.length > 1024 ||
    typeof env.JWT_SECRET !== "string" ||
    env.JWT_SECRET.length < 32 ||
    typeof transport !== "function"
  ) {
    fail("gate5a_synthetic_reviewer_credential_required");
  }

  const response = await transport(`${GATE5A_STAGING_ORIGIN}/auth/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      whatsapp: GATE5A_REVIEWER_LOGIN,
      senha: password
    }),
    redirect: "error"
  });
  if (!response || response.status !== 200 || typeof response.json !== "function") {
    fail("gate5a_synthetic_reviewer_login_failed");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    fail("gate5a_synthetic_reviewer_login_failed");
  }
  if (
    body?.ok !== true ||
    body.nome_time !== GATE5A_REVIEWER_COMPANY_NAME ||
    typeof body.token !== "string" ||
    body.token.length < 32 ||
    body.token.length > 8192
  ) {
    fail("gate5a_synthetic_reviewer_login_failed");
  }
  let claims;
  try {
    claims = jwt.verify(body.token, env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "ia4tube-api",
      audience: "ia4tube-client"
    });
  } catch {
    fail("gate5a_synthetic_reviewer_session_invalid");
  }
  body.token = null;
  return Object.freeze({
    claims: requireVerifiedReviewerClaims(claims),
    companyName: requireReviewerCompanyName(body.nome_time)
  });
}

function exactAccount() {
  return Object.freeze({
    externalId: null,
    username: GATE5A_SYNTHETIC_USERNAME,
    displayName: GATE5A_SYNTHETIC_DISPLAY_NAME,
    accountType: GATE5A_SYNTHETIC_ACCOUNT_TYPE
  });
}

function canonicalSubjectMapping(env, externalUserId) {
  const instagram = loadInstagramOAuthConfig(runtimeEnvironment(env));
  if (!instagram.enabled || typeof instagram.appSecret !== "string") {
    fail("gate5a_synthetic_compliance_unavailable");
  }
  const secret = Buffer.from(instagram.appSecret, "utf8");
  const subjectKey = crypto
    .createHmac("sha256", secret)
    .update("ia4tube-meta-subject-key-v1\0", "utf8")
    .digest();
  secret.fill(0);
  try {
    return Object.freeze({
      provider: "instagram",
      subjectDigest: crypto
        .createHmac("sha256", subjectKey)
        .update("ia4tube-meta-subject-v1\0", "utf8")
        .update("instagram", "ascii")
        .update("\0", "ascii")
        .update(externalUserId, "ascii")
        .digest("hex"),
      digestVersion: "hmac-sha256-app-secret-v1"
    });
  } finally {
    subjectKey.fill(0);
  }
}

function syntheticTokenBuffer(env, identity) {
  const identityConfig = parseIdentityConfig(env);
  const digest = crypto
    .createHmac("sha256", identityConfig.key)
    .update("ia4tube-gate5a-synthetic-token-v1\0", "utf8")
    .update(identity.companyId, "ascii")
    .update("\0", "ascii")
    .update(identity.connectionId, "ascii")
    .update("\0", "ascii")
    .update(identity.credentialId, "ascii")
    .digest();
  identityConfig.key.fill(0);
  try {
    return Buffer.concat([
      Buffer.from(GATE5A_SYNTHETIC_TOKEN_PREFIX, "utf8"),
      digest
    ]);
  } finally {
    digest.fill(0);
  }
}

function destroyBridgeSnapshot(snapshot) {
  const envelope = snapshot?.credentialEnvelope;
  if (!envelope) return;
  for (const value of [
    envelope.ciphertext,
    envelope.nonce,
    envelope.authTag
  ]) {
    if (Buffer.isBuffer(value)) value.fill(0);
  }
}

async function inspectGate5aSyntheticBridge(options = {}) {
  const env = options.env || process.env;
  requireGate5aSyntheticBridgeEnabled(env);
  const identity = options.identity || deriveGate5aSyntheticIdentity(env);
  const loadConfig = options.loadRuntimeConfig || loadRuntimePostgresConfig;
  const createPool = options.createRuntimePool || createPostgresPool;
  const closePool = options.closeRuntimePool || closePostgresPool;
  const transact = options.runtimeTransact || withTransaction;
  const config = loadConfig(runtimeEnvironment(env));
  validateRuntimeTarget(config);

  let pool;
  let row;
  let operationError;
  try {
    pool = createPool(config.pool, {
      logger: options.logger,
      PoolClass: options.RuntimePoolClass
    });
    const result = await transact(
      pool,
      (client) => client.query(
        [
          "SELECT",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.companies WHERE id=$1) AS companies,",
          " (SELECT name FROM ia4tube_social.companies WHERE id=$1) AS company_name,",
          " (SELECT status FROM ia4tube_social.companies WHERE id=$1) AS company_status,",
          " (SELECT identity_derivation_version FROM ia4tube_social.companies WHERE id=$1) AS company_derivation,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.users WHERE company_id=$1 AND id=$2) AS users,",
          " (SELECT password_hash IS NULL FROM ia4tube_social.users WHERE company_id=$1 AND id=$2) AS user_password_absent,",
          " (SELECT status FROM ia4tube_social.users WHERE company_id=$1 AND id=$2) AS user_status,",
          " (SELECT auth_version FROM ia4tube_social.users WHERE company_id=$1 AND id=$2) AS user_auth_version,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.company_memberships WHERE company_id=$1 AND user_id=$2) AS memberships,",
          " (SELECT role FROM ia4tube_social.company_memberships WHERE company_id=$1 AND user_id=$2) AS membership_role,",
          " (SELECT status FROM ia4tube_social.company_memberships WHERE company_id=$1 AND user_id=$2) AS membership_status,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_connections WHERE company_id=$1) AS company_connections,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_connections WHERE company_id=$1 AND id=$3) AS connections,",
          " (SELECT provider FROM ia4tube_social.social_connections WHERE company_id=$1 AND id=$3) AS connection_provider,",
          " (SELECT status FROM ia4tube_social.social_connections WHERE company_id=$1 AND id=$3) AS connection_status,",
          " (SELECT created_by_user_id FROM ia4tube_social.social_connections WHERE company_id=$1 AND id=$3) AS connection_user_id,",
          " (SELECT revision FROM ia4tube_social.social_connections WHERE company_id=$1 AND id=$3) AS connection_revision,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_external_accounts WHERE company_id=$1) AS company_accounts,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_external_accounts WHERE company_id=$1 AND connection_id=$3) AS accounts,",
          " (SELECT external_id FROM ia4tube_social.social_external_accounts WHERE company_id=$1 AND connection_id=$3) AS external_id,",
          " (SELECT username FROM ia4tube_social.social_external_accounts WHERE company_id=$1 AND connection_id=$3) AS username,",
          " (SELECT display_name FROM ia4tube_social.social_external_accounts WHERE company_id=$1 AND connection_id=$3) AS display_name,",
          " (SELECT account_type FROM ia4tube_social.social_external_accounts WHERE company_id=$1 AND connection_id=$3) AS account_type,",
          " (SELECT status FROM ia4tube_social.social_external_accounts WHERE company_id=$1 AND connection_id=$3) AS account_status,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$1) AS company_mappings,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$1 AND connection_id=$3) AS mappings,",
          " (SELECT provider FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$1 AND connection_id=$3) AS mapping_provider,",
          " (SELECT subject_digest FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$1 AND connection_id=$3) AS mapping_digest,",
          " (SELECT digest_version FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$1 AND connection_id=$3) AS mapping_digest_version,",
          " (SELECT user_id FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$1 AND connection_id=$3) AS mapping_user_id,",
          " (SELECT status FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$1 AND connection_id=$3) AS mapping_status,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_connection_scopes WHERE company_id=$1 AND connection_id=$3) AS scopes,",
          " (SELECT COALESCE(array_agg(scope ORDER BY scope),'{}'::text[]) FROM ia4tube_social.social_connection_scopes WHERE company_id=$1 AND connection_id=$3) AS scope_names,",
          " (SELECT COALESCE(array_agg(scope ORDER BY scope) FILTER (WHERE expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP),'{}'::text[]) FROM ia4tube_social.social_connection_scopes WHERE company_id=$1 AND connection_id=$3) AS active_scope_names,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1) AS company_credentials,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credentials,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_encrypted_credentials credential WHERE credential.company_id=$1 AND credential.provider='instagram' AND credential.credential_type IN ('instagram_user_access_token','access_token') AND (credential.connection_id=$3 OR credential.oauth_transaction_id IN (SELECT oauth.id FROM ia4tube_social.social_oauth_transactions oauth WHERE oauth.company_id=$1 AND oauth.provider='instagram' AND oauth.connection_id=$3))) AS token_materials,",
          " (SELECT id FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_id,",
          " (SELECT provider FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_provider,",
          " (SELECT connection_id FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_connection_id,",
          " (SELECT oauth_transaction_id FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_oauth_transaction_id,",
          " (SELECT credential_type FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_type,",
          " (SELECT key_version FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_key_version,",
          " (SELECT aad_version FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_aad_version,",
          " (SELECT revision FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_revision,",
          " (SELECT revoked_at IS NOT NULL FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_revoked,",
          " (SELECT ciphertext FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_ciphertext,",
          " (SELECT nonce FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_nonce,",
          " (SELECT auth_tag FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1 AND connection_id=$3) AS credential_auth_tag,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_oauth_transactions WHERE company_id=$1) AS oauth_transactions,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_compliance_requests WHERE company_id=$1) AS requests,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_compliance_requests WHERE company_id=$1 AND provider='instagram' AND kind='data_deletion' AND user_id=$2 AND connection_id=$3) AS deletion_requests,",
          " (SELECT status FROM ia4tube_social.social_compliance_requests WHERE company_id=$1 AND provider='instagram' AND kind='data_deletion' AND user_id=$2 AND connection_id=$3) AS deletion_status,",
          " (SELECT confirmation_code FROM ia4tube_social.social_compliance_requests WHERE company_id=$1 AND provider='instagram' AND kind='data_deletion' AND user_id=$2 AND connection_id=$3) AS deletion_confirmation_code,",
          " (SELECT subject_digest FROM ia4tube_social.social_compliance_requests WHERE company_id=$1 AND provider='instagram' AND kind='data_deletion' AND user_id=$2 AND connection_id=$3) AS deletion_subject_digest,",
          " (SELECT token_materials_deleted FROM ia4tube_social.social_compliance_requests WHERE company_id=$1 AND provider='instagram' AND kind='data_deletion' AND user_id=$2 AND connection_id=$3) AS deletion_token_materials,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publications WHERE company_id=$1) AS publications,",
          " (SELECT id FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_id,",
          " (SELECT connection_id FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_connection_id,",
          " (SELECT provider FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_provider,",
          " (SELECT media_reference FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_media_reference,",
          " (SELECT media_metadata_digest FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_media_metadata_digest,",
          " (SELECT caption FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_caption,",
          " (SELECT state FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_state,",
          " (SELECT idempotency_key FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_idempotency_key,",
          " (SELECT request_hash FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_request_hash,",
          " (SELECT confirmed_provider_reference FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_confirmed_reference,",
          " (SELECT reconciliation_reference FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_reconciliation_reference,",
          " (SELECT published_at FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_published_at,",
          " (SELECT revision FROM ia4tube_social.social_publications WHERE company_id=$1) AS publication_revision,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publication_attempts WHERE company_id=$1) AS publication_attempts,",
          " (SELECT state FROM ia4tube_social.social_publication_attempts WHERE company_id=$1 ORDER BY attempt_number DESC LIMIT 1) AS publication_attempt_state,",
          " (SELECT provider_reference FROM ia4tube_social.social_publication_attempts WHERE company_id=$1 ORDER BY attempt_number DESC LIMIT 1) AS publication_attempt_reference"
        ].join("\n"),
        [
          identity.companyId,
          identity.userId,
          identity.connectionId
        ]
      ),
      { companyId: identity.companyId, role: config.role }
    );
    if (!Array.isArray(result.rows) || result.rows.length !== 1) {
      fail("gate5a_synthetic_bridge_state_invalid");
    }
    row = result.rows[0];
  } catch (error) {
    operationError = error;
  }
  if (pool) {
    try {
      await closePool(pool);
    } catch (error) {
      if (!operationError) operationError = error;
    }
  }
  if (operationError) throw operationError;

  const snapshot = { ...row };
  delete snapshot.credential_ciphertext;
  delete snapshot.credential_nonce;
  delete snapshot.credential_auth_tag;
  Object.defineProperty(snapshot, "credentialEnvelope", {
    value: row.credential_ciphertext
      ? Object.freeze({
          ciphertext: row.credential_ciphertext,
          nonce: row.credential_nonce,
          authTag: row.credential_auth_tag,
          keyVersion: row.credential_key_version,
          aadVersion: Number(row.credential_aad_version)
        })
      : null,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(snapshot);
}

function exactStringArray(value, expected) {
  return Array.isArray(value) &&
    JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
}

function exactGate5aReviewerHistory(snapshot, identity) {
  const publicationCount = Number(snapshot.publications);
  const attemptCount = Number(snapshot.publication_attempts);
  if (publicationCount === 0) {
    return attemptCount === 0 &&
      snapshot.publication_id === null &&
      snapshot.publication_attempt_state === null &&
      snapshot.publication_attempt_reference === null;
  }
  if (publicationCount !== 1) return false;

  const expected = gate5aReviewerPublicationPayload(identity, {
    caption: snapshot.publication_caption,
    mediaReference: snapshot.publication_media_reference
  });
  const state = snapshot.publication_state;
  const expectedRevision = {
    ready: 1,
    publishing: 2,
    provider_confirming: 3,
    published: 4
  }[state];
  if (
    expectedRevision === undefined ||
    snapshot.publication_id !== expected.ids.publicationId ||
    snapshot.publication_connection_id !== identity.connectionId ||
    snapshot.publication_provider !== "instagram" ||
    snapshot.publication_media_reference !== expected.payload.image.mediaId ||
    snapshot.publication_media_metadata_digest !==
      expected.mediaMetadataDigest ||
    snapshot.publication_caption !== expected.payload.caption ||
    snapshot.publication_idempotency_key !== expected.ids.operationId ||
    snapshot.publication_request_hash !== expected.requestHash ||
    Number(snapshot.publication_revision) !== expectedRevision
  ) {
    return false;
  }

  if (state === "ready") {
    return attemptCount === 0 &&
      snapshot.publication_confirmed_reference === null &&
      snapshot.publication_reconciliation_reference === null &&
      snapshot.publication_published_at === null;
  }
  if (attemptCount !== 1) return false;
  if (state === "publishing") {
    return snapshot.publication_attempt_state === "started" &&
      snapshot.publication_attempt_reference === null &&
      snapshot.publication_confirmed_reference === null &&
      snapshot.publication_reconciliation_reference === null &&
      snapshot.publication_published_at === null;
  }
  if (state === "provider_confirming") {
    return snapshot.publication_attempt_state === "provider_confirming" &&
      snapshot.publication_attempt_reference === null &&
      snapshot.publication_confirmed_reference === null &&
      snapshot.publication_reconciliation_reference === null &&
      snapshot.publication_published_at === null;
  }
  return snapshot.publication_attempt_state === "published" &&
    snapshot.publication_attempt_reference === expected.ids.mediaId &&
    snapshot.publication_confirmed_reference === expected.ids.mediaId &&
    snapshot.publication_reconciliation_reference === expected.ids.reference &&
    snapshot.publication_published_at !== null &&
    Number.isFinite(new Date(snapshot.publication_published_at).getTime());
}

function bridgeSnapshotState(snapshot, identity, mapping, env) {
  const scopes = [...INSTAGRAM_OAUTH_SCOPES].sort();
  const exactCore =
    Number(snapshot.companies) === 1 &&
    snapshot.company_name === GATE5A_REVIEWER_COMPANY_NAME &&
    snapshot.company_status === IDENTITY_STATUS &&
    snapshot.company_derivation === identity.derivationVersion &&
    Number(snapshot.users) === 1 &&
    snapshot.user_password_absent === true &&
    snapshot.user_status === IDENTITY_STATUS &&
    Number(snapshot.user_auth_version) === 1 &&
    Number(snapshot.memberships) === 1 &&
    snapshot.membership_role === "owner" &&
    snapshot.membership_status === IDENTITY_STATUS &&
    Number(snapshot.company_connections) === 1 &&
    Number(snapshot.connections) === 1 &&
    snapshot.connection_provider === "instagram" &&
    snapshot.connection_user_id === identity.userId &&
    Number.isSafeInteger(Number(snapshot.connection_revision)) &&
    Number(snapshot.connection_revision) >= 2 &&
    Number(snapshot.company_accounts) === 1 &&
    Number(snapshot.accounts) === 1 &&
    snapshot.external_id === identity.externalUserId &&
    snapshot.username === GATE5A_SYNTHETIC_USERNAME &&
    snapshot.display_name === GATE5A_SYNTHETIC_DISPLAY_NAME &&
    snapshot.account_type === GATE5A_SYNTHETIC_ACCOUNT_TYPE &&
    Number(snapshot.company_mappings) === 1 &&
    Number(snapshot.mappings) === 1 &&
    snapshot.mapping_provider === "instagram" &&
    snapshot.mapping_digest === mapping.subjectDigest &&
    snapshot.mapping_digest_version === mapping.digestVersion &&
    snapshot.mapping_user_id === identity.userId &&
    Number(snapshot.scopes) === scopes.length &&
    exactStringArray(snapshot.scope_names, scopes) &&
    Number(snapshot.oauth_transactions) === 0 &&
    exactGate5aReviewerHistory(snapshot, identity);
  if (!exactCore) fail("gate5a_synthetic_bridge_state_invalid");

  const credentialPresent =
    Number(snapshot.company_credentials) === 1 &&
    Number(snapshot.credentials) === 1 &&
    Number(snapshot.token_materials) === 1 &&
    snapshot.credential_id === identity.credentialId &&
    snapshot.credential_provider === "instagram" &&
    snapshot.credential_connection_id === identity.connectionId &&
    snapshot.credential_oauth_transaction_id === null &&
    snapshot.credential_type === INSTAGRAM_OAUTH_CREDENTIAL_TYPE &&
    snapshot.credential_key_version === env.SOCIAL_VAULT_ACTIVE_KEY_VERSION &&
    Number(snapshot.credential_aad_version) === 1 &&
    Number.isSafeInteger(Number(snapshot.credential_revision)) &&
    Number(snapshot.credential_revision) >= 1 &&
    snapshot.credentialEnvelope;

  if (snapshot.connection_status === "connected") {
    if (
      snapshot.account_status !== "active" ||
      snapshot.mapping_status !== "active" ||
      snapshot.credential_revoked !== false ||
      !credentialPresent ||
      !exactStringArray(snapshot.active_scope_names, scopes) ||
      Number(snapshot.requests) !== 0 ||
      Number(snapshot.deletion_requests) !== 0 ||
      snapshot.deletion_confirmation_code !== null
    ) {
      fail("gate5a_synthetic_bridge_state_invalid");
    }
    return "connected";
  }
  if (snapshot.connection_status === "disconnected") {
    if (
      snapshot.account_status !== "revoked" ||
      snapshot.mapping_status !== "active" ||
      snapshot.credential_revoked !== true ||
      !credentialPresent ||
      !exactStringArray(snapshot.active_scope_names, []) ||
      Number(snapshot.requests) !== 0 ||
      Number(snapshot.deletion_requests) !== 0 ||
      snapshot.deletion_confirmation_code !== null
    ) {
      fail("gate5a_synthetic_bridge_state_invalid");
    }
    return "disconnected";
  }
  if (snapshot.connection_status === "revoked") {
    if (
      snapshot.account_status !== "revoked" ||
      snapshot.mapping_status !== "revoked" ||
      Number(snapshot.company_credentials) !== 0 ||
      Number(snapshot.credentials) !== 0 ||
      Number(snapshot.token_materials) !== 0 ||
      snapshot.credentialEnvelope !== null ||
      !exactStringArray(snapshot.active_scope_names, []) ||
      Number(snapshot.requests) !== 1 ||
      Number(snapshot.deletion_requests) !== 1 ||
      snapshot.deletion_status !== "completed" ||
      !CONFIRMATION_CODE_PATTERN.test(
        String(snapshot.deletion_confirmation_code || "")
      ) ||
      snapshot.deletion_subject_digest !== mapping.subjectDigest ||
      Number(snapshot.deletion_token_materials) !== 1
    ) {
      fail("gate5a_synthetic_bridge_state_invalid");
    }
    return "deleted";
  }
  fail("gate5a_synthetic_bridge_state_invalid");
}

function verifySyntheticCredentialSnapshot(snapshot, identity, env) {
  const envelope = snapshot?.credentialEnvelope;
  if (!envelope) fail("gate5a_synthetic_credential_drift_detected");
  const keyring = parseVaultKeyring(runtimeEnvironment(env));
  let vault;
  try {
    vault = createSocialVault({
      keyring,
      expectedKeyringFingerprint: keyring.fingerprint
    });
  } finally {
    for (const key of keyring.keys.values()) key.fill(0);
    keyring.keys.clear();
  }
  let plaintext;
  let expected;
  try {
    plaintext = vault.decrypt(envelope, {
      companyId: identity.companyId,
      provider: "instagram",
      credentialId: identity.credentialId,
      credentialType: INSTAGRAM_OAUTH_CREDENTIAL_TYPE,
      subjectType: "connection",
      subjectId: identity.connectionId
    });
    expected = syntheticTokenBuffer(env, identity);
    if (
      plaintext.length !== expected.length ||
      !crypto.timingSafeEqual(plaintext, expected)
    ) {
      fail("gate5a_synthetic_credential_drift_detected");
    }
    return true;
  } finally {
    if (plaintext) plaintext.fill(0);
    if (expected) expected.fill(0);
    vault.destroy();
  }
}

function persistedConnectionIsExact(connection, identity) {
  const scopes = [...INSTAGRAM_OAUTH_SCOPES].sort();
  return Boolean(
    connection &&
    connection.companyId === identity.companyId &&
    connection.id === identity.connectionId &&
    connection.provider === "instagram" &&
    connection.state === "connected" &&
    connection.health === "healthy" &&
    connection.activeCredentialId === identity.credentialId &&
    connection.account?.externalId === identity.externalUserId &&
    connection.account?.username === GATE5A_SYNTHETIC_USERNAME &&
    connection.account?.displayName === GATE5A_SYNTHETIC_DISPLAY_NAME &&
    connection.account?.accountType === GATE5A_SYNTHETIC_ACCOUNT_TYPE &&
    Array.isArray(connection.grantedScopes) &&
    JSON.stringify([...connection.grantedScopes].sort()) ===
      JSON.stringify(scopes)
  );
}

function denyExternalTransport() {
  fail("gate5a_synthetic_external_transport_forbidden");
}

async function provisionGate5aSyntheticBridge(options = {}) {
  const env = options.env || process.env;
  requireGate5aSyntheticBridgeEnabled(env);
  const loadRuntimeConfig =
    options.loadRuntimeConfig || loadRuntimePostgresConfig;
  validateRuntimeTarget(loadRuntimeConfig(runtimeEnvironment(env)));
  const authenticate = options.authenticate || authenticateSyntheticReviewer;
  const authenticated = options.verifiedClaims
    ? Object.freeze({
        claims: requireVerifiedReviewerClaims(options.verifiedClaims),
        companyName: requireReviewerCompanyName(
          options.verifiedCompanyName
        )
      })
    : await authenticate({
      env,
      transport: options.loginTransport
    });
  const claims = requireVerifiedReviewerClaims(authenticated?.claims);
  requireReviewerCompanyName(authenticated?.companyName);
  const identity = deriveGate5aSyntheticIdentity(env, claims.sub);
  const subjectMapping = canonicalSubjectMapping(
    env,
    identity.externalUserId
  );
  const bootstrap = options.bootstrapIdentity || bootstrapSyntheticIdentity;
  const bootstrapResult = await bootstrap({
    ...options,
    env,
    identity
  });

  const createRuntime = options.createRuntime || createSocialRuntime;
  const runtime = await createRuntime({
    env: runtimeEnvironment(env),
    logger: options.logger,
    instagramTransport: options.instagramTransport || denyExternalTransport,
    instagramPublicationTransport:
      options.instagramPublicationTransport || denyExternalTransport,
    publicDirectory: options.publicDirectory,
    randomBytes: options.randomBytes,
    randomUUID: options.randomUUID,
    clock: options.clock
  });
  let operationError;
  let created = false;
  try {
    if (
      !runtime?.enabled ||
      !runtime.connectorPersistence?.store ||
      !runtime.credentials ||
      !runtime.instagramOAuth ||
      !runtime.auth ||
      typeof runtime.deriveIdentity !== "function"
    ) {
      fail("gate5a_synthetic_runtime_unavailable");
    }
    const principal = runtime.auth.fromVerifiedJwt(claims);
    if (
      principal.companyId !== identity.companyId ||
      principal.userId !== identity.userId
    ) {
      fail("gate5a_synthetic_identity_drift_detected");
    }
    const context = createConnectorContext({
      principal,
      provider: "instagram",
      environment: GATE5A_ENVIRONMENT,
      correlationId: identity.correlationId,
      auditEventId: identity.auditEventId
    });
    const store = runtime.connectorPersistence.store.scope(context);
    await store.runExclusive(async (transactionalStore) => {
      const current = await transactionalStore.getCurrentConnectionDetails();
      if (current) {
        if (!persistedConnectionIsExact(current, identity)) {
          fail("gate5a_synthetic_connection_drift_detected");
        }
        return;
      }

      await transactionalStore.saveConnection({
        companyId: identity.companyId,
        id: identity.connectionId,
        provider: "instagram",
        state: "authorization_pending",
        account: null,
        revision: 1
      }, null);

      const token = syntheticTokenBuffer(env, identity);
      const account = {
        ...exactAccount(),
        externalId: identity.externalUserId
      };
      await runtime.credentials.withEncryptedConnectionCredential({
        companyId: identity.companyId,
        connectionId: identity.connectionId,
        credentialId: identity.credentialId,
        provider: "instagram",
        credentialType: INSTAGRAM_OAUTH_CREDENTIAL_TYPE,
        plaintext: token,
        expiresAt: null
      }, (envelope) => transactionalStore.activateConnectionWithCredential({
        companyId: identity.companyId,
        id: identity.connectionId,
        provider: "instagram",
        state: "connected",
        account,
        revision: 2
      }, 1, envelope, {
        grantedScopes: INSTAGRAM_OAUTH_SCOPES,
        subjectMapping
      }));
      created = true;
    });

    const publicConnection = await runtime.instagramOAuth.getConnection({
      verifiedClaims: claims,
      connectionId: identity.connectionId
    });
    if (
      publicConnection?.connection?.connectionId !== identity.connectionId ||
      publicConnection.connection.username !==
        `@${GATE5A_SYNTHETIC_USERNAME}` ||
      publicConnection.connection.accountType !==
        GATE5A_SYNTHETIC_ACCOUNT_TYPE ||
      publicConnection.connection.state !== "connected" ||
      publicConnection.connection.health !== "healthy"
    ) {
      fail("gate5a_synthetic_connection_validation_failed");
    }
    const persisted = await store.getConnectionDetails(
      identity.connectionId
    );
    if (!persistedConnectionIsExact(persisted, identity)) {
      fail("gate5a_synthetic_connection_validation_failed");
    }
    const snapshot = await inspectGate5aSyntheticBridge({
      ...options,
      env,
      identity
    });
    try {
      if (
        bridgeSnapshotState(snapshot, identity, subjectMapping, env) !==
        "connected"
      ) {
        fail("gate5a_synthetic_connection_validation_failed");
      }
      verifySyntheticCredentialSnapshot(snapshot, identity, env);
    } finally {
      destroyBridgeSnapshot(snapshot);
    }
  } catch (error) {
    operationError = error;
  }
  try {
    await runtime.close();
  } catch (error) {
    if (!operationError) operationError = error;
  }
  if (operationError) throw operationError;

  return Object.freeze({
    ok: true,
    classification: "D",
    targetValidated: true,
    stagingGateValidated: true,
    identityInserted: Number(bootstrapResult?.inserted || 0),
    identityAlreadyExact: Number(bootstrapResult?.alreadyExact || 0),
    connectionCreated: created,
    connectionAlreadyExact: !created,
    persistedSyntheticConnection: true,
    persistedSyntheticCredential: true,
    canonicalVaultUsed: true,
    tenantBound: true,
    externalMetaCalls: 0,
    externalInstagramCalls: 0,
    externalPublicationCalls: 0,
    tokenExposed: false
  });
}

function requireReviewerResolverContext(context) {
  if (
    !context ||
    typeof context !== "object" ||
    context.tenantId !== GATE5A_REVIEWER_LOGIN ||
    context.principalId !== GATE5A_REVIEWER_LOGIN ||
    context.role !== "owner" ||
    context.companyName !== GATE5A_REVIEWER_COMPANY_NAME
  ) {
    fail("gate5a_synthetic_reviewer_identity_mismatch");
  }
  requireVerifiedReviewerClaims(context.verifiedClaims);
  return context;
}

function syntheticSignedRequest(env, externalUserId, issuedAt) {
  const instagram = loadInstagramOAuthConfig(runtimeEnvironment(env));
  if (!instagram.enabled || typeof instagram.appSecret !== "string") {
    fail("gate5a_synthetic_compliance_unavailable");
  }
  const payload = Buffer.from(JSON.stringify({
    algorithm: "HMAC-SHA256",
    user_id: externalUserId,
    issued_at: issuedAt
  }), "utf8").toString("base64url");
  const secret = Buffer.from(instagram.appSecret, "utf8");
  try {
    const signature = crypto
      .createHmac("sha256", secret)
      .update(payload, "ascii")
      .digest("base64url");
    return `${signature}.${payload}`;
  } finally {
    secret.fill(0);
  }
}

async function withSyntheticBridgeMutationGuard(
  options,
  identity,
  operation
) {
  if (typeof operation !== "function") {
    fail("gate5a_synthetic_resolver_configuration_invalid");
  }
  const env = options.env || process.env;
  const loadConfig = options.loadRuntimeConfig || loadRuntimePostgresConfig;
  const createPool = options.createRuntimePool || createPostgresPool;
  const closePool = options.closeRuntimePool || closePostgresPool;
  const transact = options.runtimeTransact || withTransaction;
  const config = loadConfig(runtimeEnvironment(env));
  validateRuntimeTarget(config);
  let pool;
  let result;
  let operationError;
  try {
    pool = createPool(config.pool, {
      logger: options.logger,
      PoolClass: options.RuntimePoolClass
    });
    result = await transact(
      pool,
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",
          [`${identity.companyId}:instagram`]
        );
        return operation();
      },
      { companyId: identity.companyId, role: config.role }
    );
  } catch (error) {
    operationError = error;
  }
  if (pool) {
    try {
      await closePool(pool);
    } catch (error) {
      if (!operationError) operationError = error;
    }
  }
  if (operationError) throw operationError;
  return result;
}

function createGate5aSyntheticReviewerResolver(options = {}) {
  const env = options.env || process.env;
  const getRuntime = options.getRuntime;
  const clock = options.clock || Date.now;
  if (typeof getRuntime !== "function" || typeof clock !== "function") {
    fail("gate5a_synthetic_resolver_configuration_invalid");
  }
  let operationTail = Promise.resolve();

  function serialize(operation) {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function dependencies(context) {
    requireGate5aSyntheticBridgeEnabled(env);
    requireReviewerResolverContext(context);
    const runtime = getRuntime();
    if (
      !runtime?.enabled ||
      !runtime.instagramOAuth ||
      !runtime.metaCompliance ||
      typeof runtime.auth?.fromVerifiedJwt !== "function" ||
      typeof runtime.connectorPersistence?.store?.scope !== "function"
    ) {
      fail("gate5a_synthetic_runtime_unavailable");
    }
    const identity = deriveGate5aSyntheticIdentity(env, context.tenantId);
    const mapping = canonicalSubjectMapping(env, identity.externalUserId);
    return Object.freeze({ identity, mapping, runtime });
  }

  async function persistedState(dependenciesValue) {
    const { identity, mapping } = dependenciesValue;
    const snapshot = await inspectGate5aSyntheticBridge({
      ...options,
      env,
      identity
    });
    try {
      const status = bridgeSnapshotState(snapshot, identity, mapping, env);
      if (status !== "deleted") {
        verifySyntheticCredentialSnapshot(snapshot, identity, env);
      }
      return Object.freeze({
        status,
        deletion: status === "deleted"
          ? Object.freeze({
              confirmationCode: snapshot.deletion_confirmation_code,
              status: "completed",
              statusUrl: gate5aReviewerStatusUrl(
                snapshot.deletion_confirmation_code
              )
            })
          : null
      });
    } finally {
      destroyBridgeSnapshot(snapshot);
    }
  }

  function publicState(persisted) {
    const status = persisted?.status;
    if (status === "connected") {
      return Object.freeze({
        status: "connected",
        account: Object.freeze({
          accountId: "synthetic-gate5a-reviewer-account",
          username: `@${GATE5A_SYNTHETIC_USERNAME}`,
          accountType: "BUSINESS",
          professional: true,
          synthetic: true
        }),
        tokenPhysicallyDeleted: false
      });
    }
    return Object.freeze({
      status,
      account: null,
      tokenPhysicallyDeleted: status === "deleted",
      ...(status === "deleted"
        ? { deletion: persisted.deletion }
        : {})
    });
  }

  function reviewerStore(resolved, context) {
    const principal = resolved.runtime.auth.fromVerifiedJwt(
      context.verifiedClaims
    );
    if (
      principal?.companyId !== resolved.identity.companyId ||
      principal?.userId !== resolved.identity.userId
    ) {
      fail("gate5a_synthetic_identity_drift_detected");
    }
    return resolved.runtime.connectorPersistence.store.scope(
      createConnectorContext({
        principal,
        provider: "instagram",
        environment: GATE5A_ENVIRONMENT,
        correlationId: crypto.randomUUID(),
        auditEventId: crypto.randomUUID()
      })
    );
  }

  function reviewerHistorySummary(details, identity) {
    if (details === null || details === undefined) return null;
    const expected = gate5aReviewerPublicationPayload(identity, {
      caption: details.caption,
      mediaReference: details.mediaReference
    });
    const expectedRevision = {
      ready: 1,
      publishing: 2,
      provider_confirming: 3,
      published: 4
    }[details.state];
    const attempts = Array.isArray(details.attempts)
      ? details.attempts
      : [];
    const expectedAttemptState = {
      publishing: "started",
      provider_confirming: "provider_confirming",
      published: "published"
    }[details.state];
    const exactAttempt = details.state === "ready"
      ? attempts.length === 0
      : attempts.length === 1 &&
        attempts[0]?.attemptNumber === 1 &&
        attempts[0]?.state === expectedAttemptState &&
        attempts[0]?.errorCode === null &&
        attempts[0]?.providerReference === (
          details.state === "published" ? expected.ids.mediaId : null
        );
    const exactConfirmation = details.state === "published"
      ? details.confirmedProviderReference === expected.ids.mediaId &&
        details.reconciliationReference === expected.ids.reference &&
        details.publishedAt instanceof Date &&
        Number.isFinite(details.publishedAt.getTime())
      : details.confirmedProviderReference === null &&
        details.reconciliationReference === null &&
        details.publishedAt === null;
    if (
      expectedRevision === undefined ||
      details.companyId !== identity.companyId ||
      details.id !== expected.ids.publicationId ||
      details.connectionId !== identity.connectionId ||
      details.provider !== "instagram" ||
      details.mediaReference !== expected.payload.image.mediaId ||
      details.mediaMetadataDigest !== expected.mediaMetadataDigest ||
      details.caption !== expected.payload.caption ||
      details.idempotencyKey !== expected.ids.operationId ||
      details.requestHash !== expected.requestHash ||
      details.revision !== expectedRevision ||
      !exactAttempt ||
      !exactConfirmation
    ) {
      fail("gate5a_synthetic_history_drift_detected");
    }
    const publicationId = `synthetic-publication-${details.id}`;
    return Object.freeze({
      publicationId,
      state: details.state === "ready" || details.state === "publishing"
        ? "sending"
        : details.state,
      attempts: attempts.length,
      mediaId: details.state === "published" ? expected.ids.mediaId : null,
      publishedAt: details.state === "published"
        ? details.publishedAt.toISOString()
        : null,
      reference: details.state === "published" ? expected.ids.reference : null,
      permalink: details.state === "published"
        ? `${GATE5A_STAGING_ORIGIN}/app.html?review=instagram-publishing&` +
          `publication=${encodeURIComponent(publicationId)}`
        : null,
      synthetic: true
    });
  }

  function reviewerHistoryEnvelope(summary, extra = {}) {
    return Object.freeze({
      ...extra,
      publication: summary,
      publications: Object.freeze(
        summary?.state === "published" ? [summary] : []
      )
    });
  }

  function reviewerPublicationRecord(details, patch = {}) {
    return {
      companyId: details.companyId,
      id: details.id,
      connectionId: details.connectionId,
      provider: details.provider,
      state: details.state,
      confirmedProviderReference: details.confirmedProviderReference,
      reconciliationReference: details.reconciliationReference,
      errorCode: details.errorCode,
      revision: details.revision,
      mediaReference: details.mediaReference,
      mediaMetadataDigest: details.mediaMetadataDigest,
      caption: details.caption,
      idempotencyKey: details.idempotencyKey,
      requestHash: details.requestHash,
      ...patch
    };
  }

  async function readHistoryUnlocked(context) {
    const resolved = dependencies(context);
    const expected = gate5aReviewerPublicationIdentity(resolved.identity);
    const details = await reviewerStore(resolved, context)
      .getPublicationDetails(expected.publicationId);
    return reviewerHistoryEnvelope(
      reviewerHistorySummary(details, resolved.identity)
    );
  }

  async function publishHistoryUnlocked(context, input, content) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).length !== 1 ||
      input.clientRequestId !== GATE5A_REVIEWER_CLIENT_REQUEST_ID
    ) {
      fail("gate5a_synthetic_history_request_invalid");
    }
    const resolved = dependencies(context);
    const expected = gate5aReviewerPublicationPayload(
      resolved.identity,
      content
    );
    return reviewerStore(resolved, context).runExclusive(async (store) => {
      const connection = await store.getConnectionDetails(
        resolved.identity.connectionId
      );
      if (
        !connection ||
        connection.companyId !== resolved.identity.companyId ||
        connection.id !== resolved.identity.connectionId ||
        connection.provider !== "instagram" ||
        connection.state !== "connected"
      ) {
        fail("gate5a_synthetic_connection_unavailable");
      }
      let details = await store.getPublicationDetails(
        expected.ids.publicationId
      );
      const idempotentReplay = Boolean(details);
      const reservation = await store.beginIdempotency({
        capability: "publishImage",
        operationId: expected.ids.operationId,
        digest: expected.requestHash,
        payload: expected.payload
      });
      if (!reservation || !["acquired", "pending", "completed"].includes(
        reservation.status
      )) {
        fail("gate5a_synthetic_history_persistence_failed");
      }
      details = await store.getPublicationDetails(
        expected.ids.publicationId
      );
      if (!details) fail("gate5a_synthetic_history_persistence_failed");
      if (details.state === "ready") {
        await store.savePublication(reviewerPublicationRecord(details, {
          state: "publishing",
          revision: details.revision + 1
        }), details.revision);
        details = await store.getPublicationDetails(
          expected.ids.publicationId
        );
      }
      const summary = reviewerHistorySummary(details, resolved.identity);
      if (!idempotentReplay && summary.state !== "sending") {
        fail("gate5a_synthetic_history_state_invalid");
      }
      return reviewerHistoryEnvelope(summary, { idempotentReplay });
    });
  }

  async function advanceHistoryUnlocked(context, publicationId) {
    const resolved = dependencies(context);
    const ids = gate5aReviewerPublicationIdentity(resolved.identity);
    if (publicationId !== `synthetic-publication-${ids.publicationId}`) {
      fail("gate5a_synthetic_history_not_found");
    }
    return reviewerStore(resolved, context).runExclusive(async (store) => {
      const connection = await store.getConnectionDetails(
        resolved.identity.connectionId
      );
      if (!connection || connection.state !== "connected") {
        fail("gate5a_synthetic_connection_unavailable");
      }
      let details = await store.getPublicationDetails(
        ids.publicationId
      );
      if (!details) fail("gate5a_synthetic_history_not_found");
      const expected = gate5aReviewerPublicationPayload(resolved.identity, {
        caption: details.caption,
        mediaReference: details.mediaReference
      });
      reviewerHistorySummary(details, resolved.identity);
      if (details.state === "publishing") {
        await store.savePublication(reviewerPublicationRecord(details, {
          state: "provider_confirming",
          revision: details.revision + 1
        }), details.revision);
      } else if (details.state === "provider_confirming") {
        await store.savePublication(reviewerPublicationRecord(details, {
          state: "published",
          confirmedProviderReference: expected.ids.mediaId,
          reconciliationReference: expected.ids.reference,
          revision: details.revision + 1
        }), details.revision);
        details = await store.getPublicationDetails(
          expected.ids.publicationId
        );
        await store.completeIdempotency({
          capability: "publishImage",
          operationId: expected.ids.operationId,
          digest: expected.requestHash,
          result: {
            publicationId: details.id,
            connectionId: details.connectionId,
            provider: details.provider,
            state: details.state,
            confirmedProviderReference: details.confirmedProviderReference,
            reconciliationReference: details.reconciliationReference,
            revision: details.revision
          },
          errorCode: null
        });
      }
      details = await store.getPublicationDetails(expected.ids.publicationId);
      return reviewerHistoryEnvelope(
        reviewerHistorySummary(details, resolved.identity)
      );
    });
  }

  async function readUnlocked(context) {
    const resolved = dependencies(context);
    const state = await persistedState(resolved);
    if (state.status === "connected") {
      const result = await resolved.runtime.instagramOAuth.getConnection({
        verifiedClaims: context.verifiedClaims,
        connectionId: resolved.identity.connectionId
      });
      const connection = result?.connection;
      if (
        !connection ||
        connection.connectionId !== resolved.identity.connectionId ||
        connection.provider !== "instagram" ||
        connection.health !== "healthy" ||
        connection.username !== `@${GATE5A_SYNTHETIC_USERNAME}` ||
        connection.accountType !== GATE5A_SYNTHETIC_ACCOUNT_TYPE ||
        connection.state !== "connected"
      ) {
        fail("gate5a_synthetic_connection_drift_detected");
      }
    }
    return publicState(state);
  }

  async function disconnectUnlocked(context) {
    const resolved = dependencies(context);
    const before = await persistedState(resolved);
    if (before.status === "disconnected") return publicState(before);
    if (before.status !== "connected") {
      fail("gate5a_synthetic_connection_unavailable");
    }
    const result = await resolved.runtime.instagramOAuth.disconnect({
      verifiedClaims: context.verifiedClaims,
      connectionId: resolved.identity.connectionId
    });
    if (
      result?.connection?.connectionId !== resolved.identity.connectionId ||
      result.connection.state !== "disconnected" ||
      result.connection.health !== "disconnected"
    ) {
      fail("gate5a_synthetic_disconnect_unconfirmed");
    }
    const after = await persistedState(resolved);
    if (after.status !== "disconnected") {
      fail("gate5a_synthetic_disconnect_unconfirmed");
    }
    return publicState(after);
  }

  async function deleteConnectionDataUnlocked(context, resolved) {
    const before = await persistedState(resolved);
    if (before.status === "deleted") return publicState(before);
    if (before.status !== "disconnected") {
      fail("gate5a_synthetic_connection_unavailable");
    }
    const now = Number(clock());
    if (!Number.isFinite(now) || now < 1000) {
      fail("gate5a_synthetic_clock_invalid");
    }
    const signedRequest = syntheticSignedRequest(
      env,
      resolved.identity.externalUserId,
      Math.floor(now / 1000)
    );
    const result = await resolved.runtime.metaCompliance.handleDataDeletion({
      signedRequest
    });
    if (
      result?.status !== "completed" ||
      result.replayed !== false ||
      result.tokenMaterialsDeleted !== 1 ||
      !CONFIRMATION_CODE_PATTERN.test(
        String(result.confirmationCode || "")
      ) ||
      result.statusUrl !== gate5aReviewerStatusUrl(result.confirmationCode)
    ) {
      fail("gate5a_synthetic_deletion_unconfirmed");
    }
    const status = await resolved.runtime.metaCompliance.getStatus({
      confirmationCode: result.confirmationCode
    });
    if (status?.status !== "completed") {
      fail("gate5a_synthetic_deletion_unconfirmed");
    }
    const after = await persistedState(resolved);
    if (
      after.status !== "deleted" ||
      after.deletion.confirmationCode !== result.confirmationCode ||
      after.deletion.statusUrl !== result.statusUrl
    ) {
      fail("gate5a_synthetic_deletion_unconfirmed");
    }
    return publicState(after);
  }

  return Object.freeze({
    advancePublication(context, publicationId) {
      return serialize(() => advanceHistoryUnlocked(context, publicationId));
    },
    deleteConnectionData(context) {
      return serialize(() => {
        const resolved = dependencies(context);
        return withSyntheticBridgeMutationGuard(
          { ...options, env },
          resolved.identity,
          () => deleteConnectionDataUnlocked(context, resolved)
        );
      });
    },
    disconnect(context) {
      return serialize(() => disconnectUnlocked(context));
    },
    publishPublication(context, input, content) {
      return serialize(() => publishHistoryUnlocked(context, input, content));
    },
    read(context) {
      return serialize(() => readUnlocked(context));
    },
    readPublicationHistory(context) {
      return serialize(() => readHistoryUnlocked(context));
    }
  });
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  provision = provisionGate5aSyntheticBridge
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write(`${JSON.stringify({
      ok: false,
      code: "gate5a_synthetic_bridge_argv_refused"
    })}\n`);
    return 2;
  }
  try {
    const result = await provision({ env });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = String(error?.code || "");
    stderr.write(`${JSON.stringify({
      ok: false,
      code: SAFE_ERROR_CODE.test(code)
        ? code
        : "gate5a_synthetic_bridge_failed"
    })}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  });
}

module.exports = {
  GATE5A_BRIDGE_APPROVAL_PREFIX,
  GATE5A_ENVIRONMENT,
  GATE5A_REVIEWER_COMPANY_NAME,
  GATE5A_REVIEWER_LOGIN,
  GATE5A_STAGING_ORIGIN,
  GATE5A_STAGING_TARGET_FINGERPRINT,
  GATE5A_SYNTHETIC_ACCOUNT_TYPE,
  GATE5A_SYNTHETIC_DISPLAY_NAME,
  GATE5A_SYNTHETIC_TOKEN_PREFIX,
  GATE5A_SYNTHETIC_USERNAME,
  bootstrapSyntheticIdentity,
  createGate5aSyntheticReviewerResolver,
  deriveGate5aSyntheticIdentity,
  exactProvisionApproval,
  gate5aReviewerSurfaceGateState,
  gate5aSyntheticBridgeGateState,
  main,
  provisionGate5aSyntheticBridge,
  syntheticSignedRequest
};
