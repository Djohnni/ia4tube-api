"use strict";

const { postgresFail } = require("../persistence/postgres/errors");
const {
  CREDENTIAL_KEY_FOREIGN_KEY
} = require("../persistence/postgres/vault-key-registry-admin");
const {
  requirePositiveInteger,
  requireUuid
} = require("../persistence/postgres/validation");
const {
  requireVaultKeyVersion
} = require("./vault-key-version");

const MAX_ROTATION_ATTEMPTS = 3;
const MAX_CREDENTIALS_PER_RUN = 1000;
const DEFAULT_BACKOFF_BASE_MS = 25;
const DEFAULT_BACKOFF_MAX_MS = 100;

function defaultBackoff(attempt) {
  const safeAttempt = requirePositiveInteger(attempt, "rotation_attempt");
  const milliseconds = Math.min(
    DEFAULT_BACKOFF_BASE_MS * 2 ** (safeAttempt - 1),
    DEFAULT_BACKOFF_MAX_MS
  );
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireCredentialIds(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_CREDENTIALS_PER_RUN
  ) {
    postgresFail(
      "vault_rotation_credentials_invalid",
      "Credenciais para rotacao recusadas."
    );
  }
  const credentialIds = value.map((credentialId) =>
    requireUuid(credentialId, "credential_id")
  );
  if (new Set(credentialIds).size !== credentialIds.length) {
    postgresFail(
      "vault_rotation_credentials_duplicated",
      "Credenciais duplicadas para rotacao recusadas."
    );
  }
  return Object.freeze(credentialIds);
}

function isActiveKeyRegistryForeignKeyError(error) {
  const visited = new Set();
  for (
    let candidate = error;
    candidate && !visited.has(candidate);
    candidate = candidate?.cause
  ) {
    visited.add(candidate);
    if (
      candidate?.code === "23503" &&
      candidate?.constraint === CREDENTIAL_KEY_FOREIGN_KEY
    ) {
      return true;
    }
  }
  return false;
}

function createVaultKeyRotationService(options = {}) {
  const credentialService = options.credentialService;
  const keyRegistryAdmin = options.keyRegistryAdmin;
  const vault = options.vault;
  const backoff =
    options.backoff === undefined
      ? defaultBackoff
      : options.backoff;
  const logger = options.logger;

  if (
    !credentialService ||
    typeof credentialService.rotateForKeyLifecycle !== "function"
  ) {
    postgresFail(
      "credential_service_required",
      "Servico de credenciais obrigatorio."
    );
  }
  if (
    !keyRegistryAdmin ||
    typeof keyRegistryAdmin.register !== "function" ||
    typeof keyRegistryAdmin.retire !== "function" ||
    typeof keyRegistryAdmin.withActiveVersion !== "function"
  ) {
    postgresFail(
      "vault_key_registry_admin_required",
      "Registro administrativo de chaves obrigatorio."
    );
  }
  if (!vault || typeof vault.versions !== "function") {
    postgresFail("social_vault_required", "Cofre social obrigatorio.");
  }
  if (typeof backoff !== "function") {
    postgresFail(
      "vault_rotation_backoff_invalid",
      "Backoff da rotacao recusado."
    );
  }
  if (
    logger !== undefined &&
    (!logger ||
      (typeof logger.info !== "function" &&
        typeof logger.warn !== "function"))
  ) {
    postgresFail(
      "vault_rotation_logger_invalid",
      "Logger da rotacao recusado."
    );
  }

  function log(level, event, details = {}) {
    const operation = logger?.[level];
    if (typeof operation !== "function") return;
    try {
      const outcome = operation.call(
        logger,
        Object.freeze({
          component: "social_vault_rotation",
          event,
          ...details
        })
      );
      if (outcome && typeof outcome.catch === "function") {
        outcome.catch(() => undefined);
      }
    } catch {
      return;
    }
  }

  function readVersions() {
    let versions;
    try {
      versions = vault.versions();
    } catch {
      postgresFail(
        "vault_active_key_unavailable",
        "Chave ativa do cofre indisponivel."
      );
    }
    let active;
    let readable;
    try {
      active = requireVaultKeyVersion(versions?.active);
      readable = Array.isArray(versions?.readable)
        ? versions.readable.map((version) =>
            requireVaultKeyVersion(version)
          )
        : [];
    } catch {
      postgresFail(
        "vault_active_key_unavailable",
        "Chave ativa do cofre indisponivel."
      );
    }
    return Object.freeze({
      active,
      readable: Object.freeze([...readable])
    });
  }

  function activeState(targetVersion) {
    const versions = readVersions();
    if (
      versions.active !== targetVersion ||
      !versions.readable.includes(targetVersion)
    ) {
      postgresFail(
        "vault_active_key_unavailable",
        "Chave ativa do cofre indisponivel."
      );
    }
    return versions;
  }

  async function rotateCredential({
    companyId,
    credentialId,
    targetVersion
  }) {
    for (
      let attempt = 1;
      attempt <= MAX_ROTATION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const result =
          await credentialService.rotateForKeyLifecycle({
            companyId,
            credentialId
          });
        const keyVersion = requireVaultKeyVersion(result?.keyVersion);
        if (typeof result?.changed !== "boolean") {
          postgresFail(
            "vault_rotation_result_invalid",
            "Resultado da rotacao recusado."
          );
        }
        if (keyVersion !== targetVersion) {
          postgresFail(
            "vault_rotation_target_mismatch",
            "Destino da rotacao divergente."
          );
        }
        return Object.freeze({
          changed: result.changed,
          keyVersion,
          revision: requirePositiveInteger(
            result?.revision,
            "credential_revision"
          ),
          attempts: attempt
        });
      } catch (error) {
        if (isActiveKeyRegistryForeignKeyError(error)) {
          postgresFail(
            "vault_active_key_not_registered",
            "Chave ativa do cofre nao registrada."
          );
        }
        if (error?.code !== "credential_rotation_conflict") {
          throw error;
        }
        if (attempt === MAX_ROTATION_ATTEMPTS) {
          postgresFail(
            "credential_rotation_conflict_exhausted",
            "Conflito de rotacao persistente."
          );
        }
        log("warn", "credential_revision_conflict", { attempt });
        await backoff(attempt);
      }
    }
    postgresFail(
      "credential_rotation_conflict_exhausted",
      "Conflito de rotacao persistente."
    );
  }

  async function rotateTenant(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const targetVersion = requireVaultKeyVersion(input.keyVersion);
    const expectedActiveKeyVersion =
      input.expectedActiveKeyVersion === undefined ||
      input.expectedActiveKeyVersion === null
        ? null
        : requireVaultKeyVersion(input.expectedActiveKeyVersion);
    const credentialIds = requireCredentialIds(input.credentialIds);

    const registration = await keyRegistryAdmin.register({
      keyVersion: targetVersion
    });
    if (
      requireVaultKeyVersion(registration?.keyVersion) !==
        targetVersion ||
      typeof registration?.registered !== "boolean"
    ) {
      postgresFail(
        "vault_key_registration_unconfirmed",
        "Registro da chave ativa nao confirmado."
      );
    }
    activeState(targetVersion);
    log("info", "active_key_ready", {
      newlyRegistered: registration?.registered === true
    });

    const barrier = await keyRegistryAdmin.withActiveVersion(
      {
        keyVersion: targetVersion,
        expectedActiveKeyVersion
      },
      async (authority) => {
        const generation = requirePositiveInteger(
          authority?.generation,
          "vault_key_generation"
        );
        if (
          requireVaultKeyVersion(authority?.activeKeyVersion) !==
          targetVersion
        ) {
          postgresFail(
            "vault_key_authority_invalid",
            "Autoridade global de chave divergente."
          );
        }
        const results = [];
        for (const credentialId of credentialIds) {
          results.push(
            await rotateCredential({
              companyId,
              credentialId,
              targetVersion
            })
          );
        }
        const changed = results.filter(
          (result) => result.changed
        ).length;
        const alreadyCurrent = results.length - changed;
        log("info", "tenant_rotation_complete", {
          generation,
          credentials: results.length,
          changed,
          alreadyCurrent
        });
        return Object.freeze({
          companyId,
          keyVersion: targetVersion,
          generation,
          credentials: results.length,
          changed,
          alreadyCurrent,
          results: Object.freeze(results)
        });
      }
    );
    if (
      barrier?.authority?.activeKeyVersion !== targetVersion ||
      !barrier?.result
    ) {
      postgresFail(
        "vault_key_authority_invalid",
        "Autoridade global de chave divergente."
      );
    }
    return barrier.result;
  }

  async function retire({ keyVersion } = {}) {
    const version = requireVaultKeyVersion(keyVersion);
    const versions = readVersions();
    if (versions.active === version) {
      postgresFail(
        "vault_active_key_retirement_refused",
        "Retirada da chave ativa recusada."
      );
    }
    const result = await keyRegistryAdmin.retire({
      keyVersion: version
    });
    if (
      result?.keyVersion !== version ||
      typeof result?.retired !== "boolean"
    ) {
      postgresFail(
        "vault_key_retirement_unconfirmed",
        "Retirada da chave nao confirmada."
      );
    }
    log("info", "key_retired", {
      retired: result.retired
    });
    return result;
  }

  return Object.freeze({ retire, rotateTenant });
}

module.exports = {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  MAX_CREDENTIALS_PER_RUN,
  MAX_ROTATION_ATTEMPTS,
  createVaultKeyRotationService,
  defaultBackoff,
  isActiveKeyRegistryForeignKeyError,
  requireCredentialIds
};
