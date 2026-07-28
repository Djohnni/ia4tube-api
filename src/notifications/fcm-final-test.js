"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  validateGenerationId,
  validatePedidoId
} = require("./art-ready-contract");
const {
  createFcmTokenCrypto
} = require("./fcm-token-crypto");
const {
  activeEncryptedFcmTokenRecords,
  atomicWriteJson,
  deactivateFcmTokens,
  registerFcmToken
} = require("./fcm-token-store");

const OWNER_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRODUCTION_FIREBASE_PROJECT_ID = "ia4tubedjo";
const FINAL_TEST_TOKEN_RECORD_FIELDS = Object.freeze([
  "ativo",
  "atualizado_em",
  "ciphertext",
  "fingerprint",
  "format_version",
  "iv",
  "key_id",
  "platform",
  "tag"
]);
const SAFE_FINAL_TEST_CODES = new Set([
  "fcm_final_test_active_token_count_invalid",
  "fcm_final_test_argument_invalid",
  "fcm_final_test_clients_invalid",
  "fcm_final_test_clients_reader_invalid",
  "fcm_final_test_clients_unavailable",
  "fcm_final_test_clock_invalid",
  "fcm_final_test_data_dir_invalid",
  "fcm_final_test_delivery_gate_closed",
  "fcm_final_test_delivery_not_confirmed",
  "fcm_final_test_delivery_outcome_uncertain",
  "fcm_final_test_device_invalid",
  "fcm_final_test_device_reader_invalid",
  "fcm_final_test_device_unavailable",
  "fcm_final_test_failed",
  "fcm_final_test_ledger_invalid",
  "fcm_final_test_ledger_locked",
  "fcm_final_test_owner_allowlist_unavailable",
  "fcm_final_test_owner_invalid",
  "fcm_final_test_owner_not_allowed",
  "fcm_final_test_owner_not_found",
  "fcm_final_test_owner_record_mismatch",
  "fcm_final_test_preflight_failed",
  "fcm_final_test_production_invariant_invalid",
  "fcm_final_test_run_already_claimed",
  "fcm_final_test_run_claimed",
  "fcm_final_test_safety_gates_invalid",
  "fcm_final_test_sent",
  "fcm_final_test_token_allowlist_unavailable",
  "fcm_final_test_token_fingerprint_invalid",
  "fcm_final_test_token_key_id_invalid",
  "fcm_final_test_token_key_id_mismatch",
  "fcm_final_test_token_not_allowed",
  "fcm_final_test_token_record_invalid",
  "fcm_final_test_token_storage_unavailable",
  "fcm_final_test_transport_invalid"
]);
const REQUIRED_FALSE_GATES = Object.freeze([
  "FCM_TOKEN_REGISTRATION_ENABLED",
  "FCM_ART_READY_EVENT_ENABLED",
  "FCM_AUTOMATIC_NOTIFICATIONS_ENABLED",
  "FCM_STATUS_NOTIFICATIONS_ENABLED",
  "FCM_SCHEDULED_NOTIFICATIONS_ENABLED",
  "FCM_MANUAL_NOTIFICATIONS_ENABLED"
]);
const LEDGER_FORMAT_VERSION = 1;
const DEVICE_FORMAT_VERSION = 1;

class FcmFinalTestError extends Error {
  constructor(code) {
    super("Operacao do teste FCM final recusada.");
    this.name = "FcmFinalTestError";
    this.code = safeFinalTestCode(code);
  }
}

function safeFinalTestCode(value, fallback = "fcm_final_test_failed") {
  const normalized = String(value || "").trim().toLowerCase();
  if (SAFE_FINAL_TEST_CODES.has(normalized)) return normalized;
  const normalizedFallback = String(fallback || "")
    .trim()
    .toLowerCase();
  return SAFE_FINAL_TEST_CODES.has(normalizedFallback)
    ? normalizedFallback
    : "fcm_final_test_failed";
}

function fail(code) {
  throw new FcmFinalTestError(code);
}

function validatedOwnerId(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !value ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f/\\]/.test(value)
  ) {
    fail("fcm_final_test_owner_invalid");
  }
  return value;
}

function allowedOwnerDigest(env = process.env) {
  const value = String(
    env.FCM_FINAL_TEST_ALLOWED_OWNER_SHA256 || ""
  ).trim();
  if (!OWNER_SHA256_PATTERN.test(value)) {
    fail("fcm_final_test_owner_allowlist_unavailable");
  }
  return Buffer.from(value, "hex");
}

function ownerDigest(ownerId) {
  return crypto
    .createHash("sha256")
    .update(validatedOwnerId(ownerId), "utf8")
    .digest();
}

function assertFinalTestAllowedOwner(ownerId, env = process.env) {
  const normalizedOwner = validatedOwnerId(ownerId);
  const actual = ownerDigest(normalizedOwner);
  const allowed = allowedOwnerDigest(env);
  if (
    actual.length !== allowed.length ||
    !crypto.timingSafeEqual(actual, allowed)
  ) {
    fail("fcm_final_test_owner_not_allowed");
  }
  return normalizedOwner;
}

function assertFinalTestOwnerBinding(
  ownerSha256,
  env = process.env
) {
  const actualValue = String(ownerSha256 || "").trim();
  if (!OWNER_SHA256_PATTERN.test(actualValue)) {
    fail("fcm_final_test_device_invalid");
  }
  const actual = Buffer.from(actualValue, "hex");
  const allowed = allowedOwnerDigest(env);
  if (
    actual.length !== allowed.length ||
    !crypto.timingSafeEqual(actual, allowed)
  ) {
    fail("fcm_final_test_owner_record_mismatch");
  }
  return actualValue;
}

function assertFinalTestSendGates(env = process.env) {
  if (String(env.FCM_DELIVERY_ENABLED || "").trim() !== "true") {
    fail("fcm_final_test_delivery_gate_closed");
  }
  for (const gate of REQUIRED_FALSE_GATES) {
    if (String(env[gate] || "").trim() !== "false") {
      fail("fcm_final_test_safety_gates_invalid");
    }
  }
  return true;
}

function assertFinalTestProductionInvariants(env = process.env) {
  if (
    String(env.NODE_ENV || "").trim() !== "production" ||
    String(env.DATA_DIR || "").trim() !== "/var/data" ||
    String(env.FIREBASE_EXPECTED_PROJECT_ID || "").trim() !==
      PRODUCTION_FIREBASE_PROJECT_ID ||
    !["", "false"].includes(String(env.FCM_MOCK || "").trim())
  ) {
    fail("fcm_final_test_production_invariant_invalid");
  }
  return "/var/data";
}

function allowedTokenFingerprint(env = process.env) {
  const value = String(
    env.FCM_FINAL_TEST_ALLOWED_TOKEN_FINGERPRINT || ""
  ).trim();
  if (!TOKEN_FINGERPRINT_PATTERN.test(value)) {
    fail("fcm_final_test_token_allowlist_unavailable");
  }
  return value;
}

function assertFinalTestAllowedTokenFingerprint(
  fingerprint,
  env = process.env
) {
  const actual = String(fingerprint || "").trim();
  if (!TOKEN_FINGERPRINT_PATTERN.test(actual)) {
    fail("fcm_final_test_token_fingerprint_invalid");
  }
  const allowed = allowedTokenFingerprint(env);
  const actualBuffer = Buffer.from(actual, "ascii");
  const allowedBuffer = Buffer.from(allowed, "ascii");
  if (
    actualBuffer.length !== allowedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, allowedBuffer)
  ) {
    fail("fcm_final_test_token_not_allowed");
  }
  return actual;
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function assertFinalTestTokenRecord(record, env = process.env) {
  if (
    !exactObjectKeys(record, FINAL_TEST_TOKEN_RECORD_FIELDS) ||
    record.ativo !== true ||
    record.platform !== "android" ||
    typeof record.atualizado_em !== "string" ||
    !record.atualizado_em ||
    Number.isNaN(Date.parse(record.atualizado_em))
  ) {
    fail("fcm_final_test_token_record_invalid");
  }

  const expectedKeyId = String(
    env.FCM_TOKEN_ACTIVE_KEY_ID || ""
  ).trim();
  const actualKeyId = String(record.key_id || "").trim();
  if (
    !KEY_ID_PATTERN.test(expectedKeyId) ||
    !KEY_ID_PATTERN.test(actualKeyId)
  ) {
    fail("fcm_final_test_token_key_id_invalid");
  }
  const expectedKeyIdBuffer = Buffer.from(expectedKeyId, "utf8");
  const actualKeyIdBuffer = Buffer.from(actualKeyId, "utf8");
  if (
    expectedKeyIdBuffer.length !== actualKeyIdBuffer.length ||
    !crypto.timingSafeEqual(expectedKeyIdBuffer, actualKeyIdBuffer)
  ) {
    fail("fcm_final_test_token_key_id_mismatch");
  }

  try {
    createFcmTokenCrypto({ env }).validateStoredRecord(record);
  } catch {
    fail("fcm_final_test_token_record_invalid");
  }
  return assertFinalTestAllowedTokenFingerprint(
    record.fingerprint,
    env
  );
}

function emptyLedger() {
  return {
    format_version: LEDGER_FORMAT_VERSION,
    claim: null
  };
}

function validateLedger(value) {
  if (
    !exactObjectKeys(value, ["claim", "format_version"]) ||
    value.format_version !== LEDGER_FORMAT_VERSION
  ) {
    fail("fcm_final_test_ledger_invalid");
  }
  if (value.claim === null) return value;
  try {
    if (
      !exactObjectKeys(
        value.claim,
        ["event_id", "pedido_id", "reserved_at", "state"]
      ) ||
      value.claim.state !== "claimed" ||
      typeof value.claim.reserved_at !== "string" ||
      !value.claim.reserved_at ||
      Number.isNaN(Date.parse(value.claim.reserved_at))
    ) {
      fail("fcm_final_test_ledger_invalid");
    }
    validateGenerationId(value.claim.event_id);
    validatePedidoId(value.claim.pedido_id);
  } catch {
    fail("fcm_final_test_ledger_invalid");
  }
  return value;
}

function readLedger(filePath, fileSystem = fs) {
  if (!fileSystem.existsSync(filePath)) return emptyLedger();
  try {
    return validateLedger(
      JSON.parse(fileSystem.readFileSync(filePath, "utf8"))
    );
  } catch (error) {
    if (error instanceof FcmFinalTestError) throw error;
    fail("fcm_final_test_ledger_invalid");
  }
}

function withLedgerLock(filePath, callback, fileSystem = fs) {
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  fileSystem.mkdirSync(directory, {
    recursive: true,
    mode: 0o700
  });
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(lockPath, "wx", 0o600);
  } catch {
    fail("fcm_final_test_ledger_locked");
  }
  try {
    return callback();
  } finally {
    try {
      fileSystem.closeSync(descriptor);
    } catch {}
    try {
      fileSystem.unlinkSync(lockPath);
    } catch {}
  }
}

function resolveFinalTestDataDir(value) {
  const raw = String(value || "").trim();
  if (!raw) fail("fcm_final_test_data_dir_invalid");
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(resolved)) {
    fail("fcm_final_test_data_dir_invalid");
  }
  return resolved;
}

function finalTestDevicePath(dataDir) {
  return path.join(
    resolveFinalTestDataDir(dataDir),
    "notifications",
    "fcm-final-test-device.json"
  );
}

function emptyFinalTestDevice(env = process.env) {
  return {
    format_version: DEVICE_FORMAT_VERSION,
    owner_sha256: allowedOwnerDigest(env).toString("hex"),
    notificacoes: {
      fcm_tokens: []
    }
  };
}

function validateFinalTestDevice(value, env = process.env) {
  if (
    !exactObjectKeys(
      value,
      ["format_version", "notificacoes", "owner_sha256"]
    ) ||
    value.format_version !== DEVICE_FORMAT_VERSION ||
    !exactObjectKeys(value.notificacoes, ["fcm_tokens"]) ||
    !Array.isArray(value.notificacoes.fcm_tokens)
  ) {
    fail("fcm_final_test_device_invalid");
  }
  assertFinalTestOwnerBinding(value.owner_sha256, env);
  return value;
}

function readFinalTestDevice({
  dataDir,
  env = process.env,
  fileSystem = fs,
  allowMissing = false
}) {
  const filePath = finalTestDevicePath(dataDir);
  if (!fileSystem.existsSync(filePath)) {
    if (allowMissing) return null;
    fail("fcm_final_test_device_unavailable");
  }
  try {
    return validateFinalTestDevice(
      JSON.parse(fileSystem.readFileSync(filePath, "utf8")),
      env
    );
  } catch (error) {
    if (error instanceof FcmFinalTestError) throw error;
    fail("fcm_final_test_device_invalid");
  }
}

function registerFinalTestDevice({
  dataDir,
  ownerId,
  token,
  previousToken = "",
  platform,
  env = process.env,
  fileSystem = fs,
  now = () => new Date()
}) {
  assertFinalTestAllowedOwner(ownerId, env);
  if (platform !== "android") {
    fail("fcm_final_test_device_invalid");
  }
  const tokenCrypto = createFcmTokenCrypto({ env });
  const filePath = finalTestDevicePath(dataDir);
  return withLedgerLock(
    filePath,
    () => {
      const device = readFinalTestDevice({
        dataDir,
        env,
        fileSystem,
        allowMissing: true
      }) || emptyFinalTestDevice(env);
      activeEncryptedFcmTokenRecords({
        cliente: device,
        tokenCrypto
      });
      const timestamp = now();
      if (
        !(timestamp instanceof Date) ||
        Number.isNaN(timestamp.getTime())
      ) {
        fail("fcm_final_test_clock_invalid");
      }
      const timestampIso = timestamp.toISOString();
      if (previousToken) {
        deactivateFcmTokens({
          cliente: device,
          tokens: [previousToken],
          reason: "final_test_token_replaced",
          now: timestampIso,
          tokenCrypto
        });
      }
      // Este cofre e deliberadamente single-slot: registros anteriores
      // pertencem apenas ao mesmo dispositivo controlado e nao sao
      // mantidos como historico.
      device.notificacoes.fcm_tokens = [];
      const result = registerFcmToken({
        cliente: device,
        token,
        platform,
        now: timestampIso,
        tokenCrypto
      });
      const activeRecords =
        device.notificacoes.fcm_tokens.filter(
          (record) => record.ativo === true
        );
      if (activeRecords.length !== 1) {
        fail("fcm_final_test_active_token_count_invalid");
      }
      if (device.notificacoes.fcm_tokens.length !== 1) {
        fail("fcm_final_test_token_record_invalid");
      }
      atomicWriteJson(filePath, device, { fileSystem });
      return Object.freeze({
        saved: result.saved === true,
        activeCount: result.activeCount
      });
    },
    fileSystem
  );
}

function deactivateFinalTestDevice({
  dataDir,
  ownerId,
  token,
  env = process.env,
  fileSystem = fs,
  now = () => new Date()
}) {
  assertFinalTestAllowedOwner(ownerId, env);
  const filePath = finalTestDevicePath(dataDir);
  return withLedgerLock(
    filePath,
    () => {
      const device = readFinalTestDevice({
        dataDir,
        env,
        fileSystem,
        allowMissing: true
      });
      if (!device) {
        return Object.freeze({
          deactivated: 0,
          activeCount: 0
        });
      }
      const tokenCrypto = createFcmTokenCrypto({ env });
      const timestamp = now();
      if (
        !(timestamp instanceof Date) ||
        Number.isNaN(timestamp.getTime())
      ) {
        fail("fcm_final_test_clock_invalid");
      }
      const result = deactivateFcmTokens({
        cliente: device,
        tokens: [token],
        reason: "final_test_client_deactivated",
        now: timestamp.toISOString(),
        tokenCrypto
      });
      if (result.deactivated > 0) {
        atomicWriteJson(filePath, device, { fileSystem });
      }
      const activeCount = activeEncryptedFcmTokenRecords({
        cliente: device,
        tokenCrypto
      }).length;
      return Object.freeze({
        deactivated: result.deactivated,
        activeCount
      });
    },
    fileSystem
  );
}

function claimFinalTestRun({
  filePath,
  eventId,
  pedidoId,
  now = () => new Date(),
  fileSystem = fs
}) {
  const normalizedEventId = validateGenerationId(eventId);
  const normalizedPedidoId = validatePedidoId(pedidoId);
  return withLedgerLock(
    filePath,
    () => {
      const ledger = readLedger(filePath, fileSystem);
      if (ledger.claim !== null) {
        fail("fcm_final_test_run_already_claimed");
      }
      const reservedAt = now();
      if (
        !(reservedAt instanceof Date) ||
        Number.isNaN(reservedAt.getTime())
      ) {
        fail("fcm_final_test_clock_invalid");
      }
      ledger.claim = {
        event_id: normalizedEventId,
        pedido_id: normalizedPedidoId,
        reserved_at: reservedAt.toISOString(),
        state: "claimed"
      };
      atomicWriteJson(filePath, ledger, { fileSystem });
      return Object.freeze({
        code: "fcm_final_test_run_claimed",
        claims: 1
      });
    },
    fileSystem
  );
}

function createFcmFinalTestRunner({
  env = process.env,
  dataDir,
  fileSystem = fs,
  now = () => new Date(),
  readTargetDevice = () => readFinalTestDevice({
    dataDir,
    env,
    fileSystem
  }),
  listActiveTokenRecords,
  sendFinalTestArtReady
}) {
  const resolvedDataDir = resolveFinalTestDataDir(dataDir);
  if (typeof readTargetDevice !== "function") {
    fail("fcm_final_test_device_reader_invalid");
  }
  if (typeof sendFinalTestArtReady !== "function") {
    fail("fcm_final_test_transport_invalid");
  }
  const listRecords = typeof listActiveTokenRecords === "function"
    ? listActiveTokenRecords
    : (cliente) => {
        const tokenCrypto = createFcmTokenCrypto({ env });
        return activeEncryptedFcmTokenRecords({
          cliente,
          tokenCrypto
        });
      };
  const ledgerPath = path.join(
    resolvedDataDir,
    "notifications",
    "fcm-final-test-ledger.json"
  );

  async function run({ ownerId, eventId, pedidoId }) {
    assertFinalTestSendGates(env);
    const normalizedOwner = assertFinalTestAllowedOwner(ownerId, env);
    const normalizedEventId = validateGenerationId(eventId);
    const normalizedPedidoId = validatePedidoId(pedidoId);

    const cliente = validateFinalTestDevice(
      readTargetDevice(normalizedOwner),
      env
    );
    if (cliente.notificacoes.fcm_tokens.length !== 1) {
      fail("fcm_final_test_active_token_count_invalid");
    }

    let activeRecords;
    try {
      activeRecords = listRecords(cliente);
    } catch {
      fail("fcm_final_test_token_storage_unavailable");
    }
    if (!Array.isArray(activeRecords) || activeRecords.length !== 1) {
      fail("fcm_final_test_active_token_count_invalid");
    }
    const record = activeRecords[0];
    const fingerprint = assertFinalTestTokenRecord(record, env);

    claimFinalTestRun({
      filePath: ledgerPath,
      eventId: normalizedEventId,
      pedidoId: normalizedPedidoId,
      now,
      fileSystem
    });

    let result;
    try {
      result = await sendFinalTestArtReady(
        {
          notificacoes: {
            fcm_tokens: [{ ...record }]
          }
        },
        {
          eventId: normalizedEventId,
          pedidoId: normalizedPedidoId,
          expectedTokenFingerprint: fingerprint
        }
      );
    } catch {
      fail("fcm_final_test_delivery_outcome_uncertain");
    }
    if (
      result?.ok !== true ||
      Number(result.sent) !== 1 ||
      Number(result.tokens) !== 1
    ) {
      fail(safeFinalTestCode(
        result?.code,
        "fcm_final_test_delivery_not_confirmed"
      ));
    }
    return Object.freeze({
      ok: true,
      code: "fcm_final_test_sent",
      recipients: 1,
      sent: 1
    });
  }

  return Object.freeze({
    ledgerPath,
    run
  });
}

function safeFinalTestOutput(error) {
  return Object.freeze({
    ok: false,
    code: safeFinalTestCode(error?.code),
    recipients: 0,
    sent: 0
  });
}

module.exports = {
  FcmFinalTestError,
  REQUIRED_FALSE_GATES,
  assertFinalTestAllowedOwner,
  assertFinalTestAllowedTokenFingerprint,
  assertFinalTestProductionInvariants,
  assertFinalTestSendGates,
  assertFinalTestTokenRecord,
  claimFinalTestRun,
  createFcmFinalTestRunner,
  deactivateFinalTestDevice,
  finalTestDevicePath,
  readFinalTestDevice,
  registerFinalTestDevice,
  safeFinalTestCode,
  safeFinalTestOutput
};
