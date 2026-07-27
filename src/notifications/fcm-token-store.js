"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  FcmTokenSecurityError,
  createFcmTokenCrypto,
  isEncryptedFcmTokenRecord
} = require("./fcm-token-crypto");

const STORED_RECORD_FIELDS = new Set([
  "format_version",
  "key_id",
  "iv",
  "ciphertext",
  "tag",
  "fingerprint",
  "platform",
  "ativo",
  "atualizado_em",
  "invalidado_em",
  "invalidado_motivo"
]);

function fail(code) {
  throw new FcmTokenSecurityError(code);
}

function tokenItems(cliente = {}) {
  return Array.isArray(cliente?.notificacoes?.fcm_tokens)
    ? cliente.notificacoes.fcm_tokens
    : [];
}

function hasLegacyPlaintextToken(item) {
  return Boolean(
    item &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    typeof item.token === "string" &&
    item.token.trim()
  );
}

function metadataForRecord(item = {}, overrides = {}) {
  const requestedPlatform = String(
    overrides.platform || item.platform || "android"
  ).trim().toLowerCase();
  return {
    platform: /^[a-z0-9._-]{1,32}$/.test(requestedPlatform)
      ? requestedPlatform
      : "android",
    ativo: overrides.ativo !== undefined
      ? overrides.ativo !== false
      : item.ativo !== false,
    atualizado_em: String(
      overrides.atualizado_em || item.atualizado_em || new Date().toISOString()
    )
  };
}

function withNecessaryMetadata(encryptedRecord, item = {}, overrides = {}) {
  const result = {
    ...encryptedRecord,
    ...metadataForRecord(item, overrides)
  };
  for (const field of ["invalidado_em", "invalidado_motivo"]) {
    const value = String(overrides[field] || item[field] || "").trim();
    if (value) result[field] = value;
  }
  return result;
}

function encryptedRecords(cliente = {}, tokenCrypto) {
  return tokenItems(cliente).map((item) => {
    if (hasLegacyPlaintextToken(item)) {
      fail("fcm_token_legacy_storage_detected");
    }
    if (
      !isEncryptedFcmTokenRecord(item) ||
      Object.keys(item).some((field) => !STORED_RECORD_FIELDS.has(field))
    ) {
      fail("fcm_token_record_invalid");
    }
    tokenCrypto.validateStoredRecord(item);
    return item;
  });
}

function registerFcmToken({
  cliente,
  token,
  platform = "android",
  now = new Date().toISOString(),
  tokenCrypto = createFcmTokenCrypto()
}) {
  if (!cliente || typeof cliente !== "object" || Array.isArray(cliente)) {
    fail("fcm_token_client_invalid");
  }
  cliente.notificacoes = cliente.notificacoes &&
    typeof cliente.notificacoes === "object" &&
    !Array.isArray(cliente.notificacoes)
    ? cliente.notificacoes
    : {};

  const records = encryptedRecords(cliente, tokenCrypto);
  const currentIndex = records.findIndex((item) =>
    tokenCrypto.recordMatchesToken(item, token)
  );
  const encrypted = withNecessaryMetadata(
    tokenCrypto.encryptToken(token),
    currentIndex >= 0 ? records[currentIndex] : {},
    { platform, ativo: true, atualizado_em: now }
  );
  if (currentIndex >= 0) records[currentIndex] = encrypted;
  else records.push(encrypted);

  cliente.notificacoes.fcm_tokens = records;
  return {
    saved: true,
    activeCount: records.filter((item) => item.ativo !== false).length,
    totalCount: records.length
  };
}

function decryptActiveFcmTokens({
  cliente,
  tokenCrypto = createFcmTokenCrypto()
}) {
  return encryptedRecords(cliente, tokenCrypto)
    .filter((item) => item.ativo !== false)
    .map((item) => tokenCrypto.decryptToken(item));
}

function activeEncryptedFcmTokenRecords({
  cliente,
  tokenCrypto = createFcmTokenCrypto()
}) {
  return encryptedRecords(cliente, tokenCrypto)
    .filter((item) => item.ativo !== false)
    .map((item) => ({ ...item }));
}

function deactivateFcmTokens({
  cliente,
  tokens = [],
  reason = "firebase_invalid_token",
  now = new Date().toISOString(),
  tokenCrypto = createFcmTokenCrypto()
}) {
  const candidates = (Array.isArray(tokens) ? tokens : [])
    .map((token) => String(token || "").trim())
    .filter(Boolean);
  if (!candidates.length) return { deactivated: 0 };

  const records = encryptedRecords(cliente, tokenCrypto);
  let deactivated = 0;
  for (const item of records) {
    if (item.ativo === false) continue;
    if (!candidates.some((token) => tokenCrypto.recordMatchesToken(item, token))) {
      continue;
    }
    item.ativo = false;
    item.invalidado_em = now;
    item.invalidado_motivo = String(reason || "firebase_invalid_token");
    item.atualizado_em = now;
    deactivated += 1;
  }
  return { deactivated };
}

function atomicWriteJson(filePath, data, {
  fileSystem = fs,
  beforeRename
} = {}) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor = null;
  let renamed = false;

  try {
    descriptor = fileSystem.openSync(temporaryPath, "wx", 0o600);
    fileSystem.writeFileSync(
      descriptor,
      `${JSON.stringify(data, null, 2)}\n`,
      { encoding: "utf8" }
    );
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    if (typeof beforeRename === "function") {
      beforeRename({ filePath, temporaryPath });
    }
    fileSystem.renameSync(temporaryPath, filePath);
    renamed = true;

    let directoryDescriptor = null;
    try {
      directoryDescriptor = fileSystem.openSync(directory, "r");
      fileSystem.fsyncSync(directoryDescriptor);
    } catch (error) {
      if (!["EISDIR", "EINVAL", "EPERM", "EACCES"].includes(error?.code)) {
        throw error;
      }
    } finally {
      if (directoryDescriptor !== null) {
        fileSystem.closeSync(directoryDescriptor);
      }
    }
  } finally {
    if (descriptor !== null) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {}
    }
    if (!renamed) {
      try {
        if (fileSystem.existsSync(temporaryPath)) {
          fileSystem.unlinkSync(temporaryPath);
        }
      } catch {}
    }
  }
}

module.exports = {
  activeEncryptedFcmTokenRecords,
  atomicWriteJson,
  deactivateFcmTokens,
  decryptActiveFcmTokens,
  hasLegacyPlaintextToken,
  registerFcmToken
};
