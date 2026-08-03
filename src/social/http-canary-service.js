"use strict";

const crypto = require("node:crypto");
const { ALGORITHM } = require("./vault");
const {
  SYNTHETIC_CANARY_PREFIX,
  createSyntheticHttpCanaryData
} = require("./http-canary-data");

const SAFE_ERROR_CODES = new Set([
  "social_http_canary_client_invalid",
  "social_http_canary_companies_must_differ",
  "social_http_canary_database_gate_failed",
  "social_http_canary_environment_forbidden",
  "social_http_canary_event_count_invalid",
  "social_http_canary_exclusive_lock_invalid",
  "social_http_canary_failed",
  "social_http_canary_fixture_a_missing",
  "social_http_canary_fixture_b_missing",
  "social_http_canary_fixture_count_invalid",
  "social_http_canary_gate_failed",
  "social_http_canary_identifier_collision",
  "social_http_canary_in_progress",
  "social_http_canary_lock_cleanup_failed",
  "social_http_canary_pool_must_be_three",
  "social_http_canary_pool_required",
  "social_http_canary_probe_unavailable",
  "social_http_canary_residual_count_invalid",
  "social_http_canary_residual_records_found",
  "social_http_canary_residual_scope_invalid",
  "social_http_canary_rls_write_allowed",
  "social_http_canary_rollback_failed",
  "social_http_canary_runtime_role_invalid",
  "social_http_canary_savepoint_cleanup_failed",
  "social_http_canary_savepoint_invalid",
  "social_http_canary_transaction_state_uncertain",
  "social_http_canary_vault_boundary_failed",
  "social_http_canary_vault_round_trip_failed",
  "social_http_canary_vault_unavailable"
]);
const SAFE_RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESULT_BOOLEAN_FIELDS = Object.freeze([
  "ownReadA",
  "ownReadB",
  "crossTenantDeniedA",
  "crossTenantDeniedB",
  "missingContextDenied",
  "tamperedContextDenied",
  "idempotentWrites",
  "mutationRolledBack",
  "vaultRoundTripPassed",
  "vaultCrossTenantDenied",
  "vaultTamperDenied",
  "cleanupCompleted"
]);
const UNSAFE_TRANSACTION_ERROR_CODES = new Set([
  "social_http_canary_rollback_failed",
  "social_http_canary_transaction_state_uncertain"
]);

function transactionStateIsUnsafe(error) {
  return UNSAFE_TRANSACTION_ERROR_CODES.has(String(error?.code || ""));
}

function safeCode(error) {
  const candidate = String(error?.code || "");
  return SAFE_ERROR_CODES.has(candidate)
    ? candidate
    : "social_http_canary_failed";
}

function sanitizeHttpCanaryResult(input = {}) {
  const result = {
    runId: SAFE_RUN_ID.test(String(input.runId || ""))
      ? String(input.runId)
      : "",
    status: input.status === "passed" ? "passed" : "failed"
  };
  for (const field of RESULT_BOOLEAN_FIELDS) {
    result[field] = input[field] === true;
  }
  result.residualRecords = Number.isSafeInteger(input.residualRecords) &&
    input.residualRecords >= 0
    ? input.residualRecords
    : null;
  result.durationMs = Number.isSafeInteger(input.durationMs) &&
    input.durationMs >= 0
    ? input.durationMs
    : 0;
  if (result.status === "failed") {
    result.errorCode = SAFE_ERROR_CODES.has(String(input.errorCode || ""))
      ? String(input.errorCode)
      : "social_http_canary_failed";
  }
  return Object.freeze(result);
}

function expectVaultFailure(operation) {
  let plaintext;
  try {
    plaintext = operation();
  } catch (error) {
    if (error?.code === "vault_authentication_failed") return true;
    throw error;
  } finally {
    if (Buffer.isBuffer(plaintext)) plaintext.fill(0);
  }
  const error = new Error("Vault accepted invalid AAD or ciphertext.");
  error.code = "social_http_canary_vault_boundary_failed";
  throw error;
}

function runVaultGate(vault, data, randomBytes = crypto.randomBytes) {
  if (
    !vault ||
    typeof vault.encrypt !== "function" ||
    typeof vault.decrypt !== "function"
  ) {
    const error = new Error("Social vault is unavailable.");
    error.code = "social_http_canary_vault_unavailable";
    throw error;
  }
  const token = Buffer.from(
    `${SYNTHETIC_CANARY_PREFIX}_${randomBytes(24).toString("hex")}`,
    "utf8"
  );
  const contextA = Object.freeze({
    companyId: data.companyA,
    provider: "canary",
    subjectType: "connection",
    subjectId: data.vault.subjectId,
    credentialId: data.vault.credentialId,
    credentialType: "access_token"
  });
  const contextB = Object.freeze({ ...contextA, companyId: data.companyB });
  let envelope;
  let roundTrip;
  let tamperedCiphertext;
  try {
    envelope = vault.encrypt(token, contextA);
    roundTrip = vault.decrypt(envelope, contextA);
    const roundTripPassed =
      ALGORITHM === "aes-256-gcm" &&
      roundTrip.length === token.length &&
      crypto.timingSafeEqual(roundTrip, token);
    if (!roundTripPassed) {
      const error = new Error("Vault round trip failed.");
      error.code = "social_http_canary_vault_round_trip_failed";
      throw error;
    }

    const vaultCrossTenantDenied = expectVaultFailure(() =>
      vault.decrypt(envelope, contextB)
    );
    tamperedCiphertext = Buffer.from(envelope.ciphertext);
    tamperedCiphertext[0] ^= 1;
    const vaultTamperDenied = expectVaultFailure(() =>
      vault.decrypt(
        { ...envelope, ciphertext: tamperedCiphertext },
        contextA
      )
    );
    return Object.freeze({
      vaultRoundTripPassed: true,
      vaultCrossTenantDenied,
      vaultTamperDenied
    });
  } finally {
    token.fill(0);
    if (roundTrip) roundTrip.fill(0);
    if (tamperedCiphertext) tamperedCiphertext.fill(0);
    if (envelope) {
      envelope.ciphertext.fill(0);
      envelope.nonce.fill(0);
      envelope.authTag.fill(0);
    }
  }
}

function createSocialHttpCanaryService(options = {}) {
  const probe = options.probe;
  const vault = options.vault;
  if (
    !probe ||
    typeof probe.runExclusive !== "function"
  ) {
    const error = new Error("Canary probe is unavailable.");
    error.code = "social_http_canary_probe_unavailable";
    throw error;
  }
  const clock = options.clock || Date.now;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const logger = options.logger;

  async function runWithinExclusiveLock(lockedProbe) {
    if (
      !lockedProbe ||
      typeof lockedProbe.runMutation !== "function" ||
      typeof lockedProbe.verifyResiduals !== "function"
    ) {
      const error = new Error("Locked canary probe is unavailable.");
      error.code = "social_http_canary_probe_unavailable";
      throw error;
    }
    const startedAt = Number(clock());
    const data = createSyntheticHttpCanaryData({
      companyA: options.companyA,
      companyB: options.companyB,
      randomUUID
    });
    let database = {};
    let vaultResult = {};
    let errorCode = "";
    let residualRecords = null;
    let cleanupCompleted = false;
    try {
      database = await lockedProbe.runMutation(data);
      vaultResult = runVaultGate(vault, data, randomBytes);
    } catch (error) {
      if (transactionStateIsUnsafe(error)) throw error;
      errorCode = safeCode(error);
    }

    try {
      residualRecords = await lockedProbe.verifyResiduals(data);
      cleanupCompleted = residualRecords === 0;
      if (!cleanupCompleted && !errorCode) {
        errorCode = "social_http_canary_residual_records_found";
      }
    } catch (error) {
      if (transactionStateIsUnsafe(error)) throw error;
      errorCode ||= safeCode(error);
    }

    const passed =
      !errorCode &&
      database.ownReadA === true &&
      database.ownReadB === true &&
      database.crossTenantDeniedA === true &&
      database.crossTenantDeniedB === true &&
      database.missingContextDenied === true &&
      database.tamperedContextDenied === true &&
      database.idempotentWrites === true &&
      database.mutationRolledBack === true &&
      vaultResult.vaultRoundTripPassed === true &&
      vaultResult.vaultCrossTenantDenied === true &&
      vaultResult.vaultTamperDenied === true &&
      cleanupCompleted;

    const result = sanitizeHttpCanaryResult({
      runId: data.runId,
      status: passed ? "passed" : "failed",
      ownReadA: database.ownReadA,
      ownReadB: database.ownReadB,
      crossTenantDeniedA: database.crossTenantDeniedA,
      crossTenantDeniedB: database.crossTenantDeniedB,
      missingContextDenied: database.missingContextDenied,
      tamperedContextDenied: database.tamperedContextDenied,
      idempotentWrites: database.idempotentWrites,
      mutationRolledBack: database.mutationRolledBack,
      vaultRoundTripPassed: vaultResult.vaultRoundTripPassed,
      vaultCrossTenantDenied: vaultResult.vaultCrossTenantDenied,
      vaultTamperDenied: vaultResult.vaultTamperDenied,
      cleanupCompleted,
      residualRecords,
      durationMs: Math.max(0, Number(clock()) - startedAt),
      errorCode: errorCode || "social_http_canary_gate_failed"
    });

    if (!passed && logger && typeof logger.error === "function") {
      logger.error(Object.freeze({
        component: "social_http_canary",
        code: result.errorCode
      }));
    }
    return result;
  }

  async function run() {
    return probe.runExclusive(runWithinExclusiveLock);
  }

  return Object.freeze({ run });
}

module.exports = {
  RESULT_BOOLEAN_FIELDS,
  SAFE_ERROR_CODES,
  createSocialHttpCanaryService,
  runVaultGate,
  sanitizeHttpCanaryResult,
  safeCode
};
