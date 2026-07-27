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

function assertNoLegacyFcmTokens(clientes = {}) {
  for (const cliente of Object.values(clientes || {})) {
    for (const item of tokenItems(cliente)) {
      if (hasLegacyPlaintextToken(item)) {
        fail("fcm_token_plaintext_persistence_forbidden");
      }
    }
  }
}

function metadataForRecord(item = {}, overrides = {}) {
  const requestedPlatform = String(
    overrides.platform ||
    item.platform ||
    "android"
  ).trim().toLowerCase();
  const platform = /^[a-z0-9._-]{1,32}$/.test(requestedPlatform)
    ? requestedPlatform
    : "android";

  return {
    platform,
    ativo: overrides.ativo !== undefined
      ? overrides.ativo !== false
      : item.ativo !== false,
    atualizado_em: String(
      overrides.atualizado_em ||
      item.atualizado_em ||
      new Date().toISOString()
    )
  };
}

function withNecessaryMetadata(encryptedRecord, item = {}, overrides = {}) {
  const metadata = metadataForRecord(item, overrides);
  const result = {
    ...encryptedRecord,
    ...metadata
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
    if (!isEncryptedFcmTokenRecord(item)) {
      fail("fcm_token_record_invalid");
    }
    if (
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
    {
      platform,
      ativo: true,
      atualizado_em: now
    }
  );

  if (currentIndex >= 0) {
    records[currentIndex] = encrypted;
  } else {
    records.push(encrypted);
  }

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
  const basename = path.basename(filePath);
  const temporaryPath = path.join(
    directory,
    `.${basename}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  let descriptor = null;
  let renamed = false;

  try {
    descriptor = fileSystem.openSync(
      temporaryPath,
      "wx",
      0o600
    );
    fileSystem.writeFileSync(descriptor, serialized, {
      encoding: "utf8"
    });
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;

    if (typeof beforeRename === "function") {
      beforeRename({
        filePath,
        temporaryPath
      });
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
      } catch {
        // Best effort only; original file has not been replaced.
      }
    }
    if (!renamed) {
      try {
        if (fileSystem.existsSync(temporaryPath)) {
          fileSystem.unlinkSync(temporaryPath);
        }
      } catch {
        // Do not hide the original failure.
      }
    }
  }
}

function sha256Upper(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex")
    .toUpperCase();
}

function validateExpectedLegacySha256(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) {
    fail("fcm_token_legacy_expected_sha256_missing");
  }
  return normalized;
}

function inspectFcmTokenStorage(clientes = {}) {
  let encrypted = 0;
  let legacy = 0;
  let active = 0;

  for (const cliente of Object.values(clientes || {})) {
    for (const item of tokenItems(cliente)) {
      if (hasLegacyPlaintextToken(item)) {
        legacy += 1;
        if (item.ativo !== false) active += 1;
      } else if (isEncryptedFcmTokenRecord(item)) {
        encrypted += 1;
        if (item.ativo !== false) active += 1;
      } else {
        fail("fcm_token_record_invalid");
      }
    }
  }

  return { encrypted, legacy, active, total: encrypted + legacy };
}

function migrateLegacyFcmTokens({
  clientes,
  expectedLegacySha256,
  expectedLegacyCount = 1,
  tokenCrypto = createFcmTokenCrypto()
}) {
  const storageBefore = inspectFcmTokenStorage(clientes);
  if (storageBefore.legacy === 0) {
    for (const cliente of Object.values(clientes || {})) {
      for (const item of tokenItems(cliente)) {
        tokenCrypto.decryptToken(item);
      }
    }
    return {
      changed: false,
      migrated: 0,
      storageBefore,
      storageAfter: storageBefore
    };
  }

  if (storageBefore.legacy !== expectedLegacyCount) {
    fail("fcm_token_legacy_count_mismatch");
  }
  const expectedSha256 = validateExpectedLegacySha256(
    expectedLegacySha256
  );
  let migrated = 0;

  for (const cliente of Object.values(clientes || {})) {
    const items = tokenItems(cliente);
    if (!items.length) continue;

    cliente.notificacoes.fcm_tokens = items.map((item) => {
      if (!hasLegacyPlaintextToken(item)) {
        tokenCrypto.decryptToken(item);
        return item;
      }

      const plaintext = String(item.token).trim();
      if (sha256Upper(plaintext) !== expectedSha256) {
        fail("fcm_token_legacy_sha256_mismatch");
      }
      migrated += 1;
      return withNecessaryMetadata(
        tokenCrypto.encryptToken(plaintext),
        item
      );
    });
  }

  assertNoLegacyFcmTokens(clientes);
  const storageAfter = inspectFcmTokenStorage(clientes);
  return {
    changed: true,
    migrated,
    storageBefore,
    storageAfter
  };
}

function readJsonFile(filePath, fileSystem = fs) {
  try {
    return JSON.parse(
      (fileSystem.readFileSync(filePath, "utf8") || "{}")
        .replace(/^\uFEFF/, "")
    );
  } catch {
    fail("fcm_token_storage_json_invalid");
  }
}

function migrateLegacyFcmTokensFile({
  filePath,
  expectedLegacySha256,
  expectedLegacyCount = 1,
  env = process.env,
  fileSystem = fs,
  beforeRename
}) {
  const clientes = readJsonFile(filePath, fileSystem);
  const storageBefore = inspectFcmTokenStorage(clientes);
  if (storageBefore.total === 0) {
    return {
      changed: false,
      migrated: 0,
      storageBefore,
      storageAfter: storageBefore
    };
  }

  const tokenCrypto = createFcmTokenCrypto({ env });
  const migration = migrateLegacyFcmTokens({
    clientes,
    expectedLegacySha256,
    expectedLegacyCount,
    tokenCrypto
  });

  if (migration.changed) {
    atomicWriteJson(filePath, clientes, {
      fileSystem,
      beforeRename
    });
  }

  const reopened = readJsonFile(filePath, fileSystem);
  assertNoLegacyFcmTokens(reopened);
  const reopenedStorage = inspectFcmTokenStorage(reopened);
  for (const cliente of Object.values(reopened || {})) {
    for (const item of tokenItems(cliente)) {
      const plaintext = tokenCrypto.decryptToken(item);
      if (
        migration.changed &&
        sha256Upper(plaintext) !==
          validateExpectedLegacySha256(expectedLegacySha256)
      ) {
        fail("fcm_token_migration_validation_failed");
      }
    }
  }

  return {
    ...migration,
    storageAfter: reopenedStorage
  };
}

module.exports = {
  activeEncryptedFcmTokenRecords,
  assertNoLegacyFcmTokens,
  atomicWriteJson,
  deactivateFcmTokens,
  decryptActiveFcmTokens,
  hasLegacyPlaintextToken,
  inspectFcmTokenStorage,
  migrateLegacyFcmTokens,
  migrateLegacyFcmTokensFile,
  registerFcmToken,
  sha256Upper
};
