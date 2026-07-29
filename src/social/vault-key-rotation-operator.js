"use strict";

const crypto = require("node:crypto");
const {
  assertNoAmbientPostgresEnvironment,
  loadMigrationPostgresConfig,
  loadRuntimePostgresConfig,
  parseDatabaseUrl
} = require("../persistence/postgres/config");
const { postgresFail } = require("../persistence/postgres/errors");
const {
  createMigrationRunner
} = require("../persistence/postgres/migrations");
const {
  closePostgresPool,
  createPostgresPool,
  verifyRuntimeRole
} = require("../persistence/postgres/pool");
const {
  verifyRuntimeSchema
} = require("../persistence/postgres/runtime-validation");
const {
  createSocialRepository
} = require("../persistence/postgres/social-repository");
const {
  createVaultKeyRegistryAdmin
} = require("../persistence/postgres/vault-key-registry-admin");
const {
  requireKeyVersion,
  requirePositiveInteger,
  requireSafeLabel,
  requireUuid
} = require("../persistence/postgres/validation");
const {
  createSocialCredentialService
} = require("./credential-service");
const {
  createSocialVault,
  parseVaultKeyring
} = require("./vault");
const {
  createVaultKeyRotationService
} = require("./vault-key-rotation-service");
const {
  assertVaultKeyringFingerprint,
  requireVaultKeyVersion
} = require("./vault-key-version");

const OPERATOR_MODES = new Set(["inventory", "prepare", "rotate"]);
const MAX_OPERATOR_BATCH_SIZE = 250;
const DEFAULT_OPERATOR_BATCH_SIZE = 100;
const UNINITIALIZED_AUTHORITY = "uninitialized";
const PRODUCTION_ROTATION_APPROVAL =
  "ROTATE_SOCIAL_VAULT_PRODUCTION_WITH_VERIFIED_BACKUP";

const OPERATOR_ENVIRONMENT_NAMES = Object.freeze([
  "SOCIAL_VAULT_ROTATION_ACTIVE_KEY_VERSION",
  "SOCIAL_VAULT_ROTATION_APPROVAL",
  "SOCIAL_VAULT_ROTATION_BATCH_SIZE",
  "SOCIAL_VAULT_ROTATION_DATABASE_CA_BASE64",
  "SOCIAL_VAULT_ROTATION_ENVIRONMENT",
  "SOCIAL_VAULT_ROTATION_EXPECTED_CURRENT_KEY_VERSION",
  "SOCIAL_VAULT_ROTATION_EXPECTED_ENVIRONMENT_ID",
  "SOCIAL_VAULT_ROTATION_EXPECTED_KEYRING_FINGERPRINT",
  "SOCIAL_VAULT_ROTATION_EXPECTED_MIGRATION_LOGIN",
  "SOCIAL_VAULT_ROTATION_EXPECTED_RUNTIME_LOGIN",
  "SOCIAL_VAULT_ROTATION_EXPECTED_TARGET_FINGERPRINT",
  "SOCIAL_VAULT_ROTATION_IDENTITY_DERIVATION_VERSION",
  "SOCIAL_VAULT_ROTATION_KEYS_JSON",
  "SOCIAL_VAULT_ROTATION_MIGRATIONS_DATABASE_URL",
  "SOCIAL_VAULT_ROTATION_PRODUCTION_APPROVAL",
  "SOCIAL_VAULT_ROTATION_RETIRE_KEY_VERSION",
  "SOCIAL_VAULT_ROTATION_RUNTIME_DATABASE_URL"
]);

function requireMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!OPERATOR_MODES.has(mode)) {
    postgresFail(
      "vault_rotation_mode_invalid",
      "Modo do operador de rotacao recusado."
    );
  }
  return mode;
}

function parseVaultRotationArguments(argv = []) {
  if (!Array.isArray(argv)) {
    postgresFail(
      "vault_rotation_arguments_invalid",
      "Argumentos do operador recusados."
    );
  }
  if (argv.length < 1 || argv.length > 2) {
    postgresFail(
      "vault_rotation_arguments_invalid",
      "Argumentos do operador recusados."
    );
  }
  const mode = requireMode(argv[0]);
  const retire = argv.length === 2 && argv[1] === "--retire-previous";
  if (
    (argv.length === 2 && !retire) ||
    (retire && mode !== "rotate")
  ) {
    postgresFail(
      "vault_rotation_arguments_invalid",
      "Argumentos do operador recusados."
    );
  }
  return Object.freeze({ mode, retire });
}

function hasValue(value) {
  return (
    value !== undefined &&
    value !== null &&
    String(value).trim().length > 0
  );
}

function requireExactApproval(env, mode, retire, environmentId) {
  const action =
    mode === "inventory"
      ? "INVENTORY_SOCIAL_VAULT"
      : mode === "prepare"
        ? "PREPARE_SOCIAL_VAULT"
      : retire
        ? "ROTATE_AND_RETIRE_SOCIAL_VAULT"
        : "ROTATE_SOCIAL_VAULT";
  const expected = `${action}:${environmentId}`;
  if (env.SOCIAL_VAULT_ROTATION_APPROVAL !== expected) {
    postgresFail(
      "vault_rotation_not_approved",
      "Operacao do cofre nao autorizada."
    );
  }
  return true;
}

function requireBatchSize(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_OPERATOR_BATCH_SIZE;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_OPERATOR_BATCH_SIZE
  ) {
    postgresFail(
      "vault_rotation_batch_size_invalid",
      "Lote do operador de rotacao recusado."
    );
  }
  return parsed;
}

function decodedUrlPart(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    postgresFail(code, "Identidade PostgreSQL recusada.");
  }
}

function connectionIdentity(parsed) {
  const username = decodedUrlPart(
    parsed.username,
    "vault_rotation_login_invalid"
  );
  if (username !== username.toLowerCase()) {
    postgresFail(
      "vault_rotation_login_invalid",
      "Identidade PostgreSQL recusada."
    );
  }
  return Object.freeze({
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database: decodedUrlPart(
      parsed.pathname.slice(1),
      "vault_rotation_database_invalid"
    ),
    username,
    password: decodedUrlPart(
      parsed.password,
      "vault_rotation_password_invalid"
    )
  });
}

function secretsEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ""), "utf8");
  const rightBytes = Buffer.from(String(right || ""), "utf8");
  try {
    return (
      leftBytes.length === rightBytes.length &&
      crypto.timingSafeEqual(leftBytes, rightBytes)
    );
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function assertSeparateDatabaseCredentials(migrationRaw, runtimeRaw) {
  const migration = connectionIdentity(
    parseDatabaseUrl(
      migrationRaw,
      "social_vault_rotation_migrations_database_url"
    )
  );
  const runtime = connectionIdentity(
    parseDatabaseUrl(
      runtimeRaw,
      "social_vault_rotation_runtime_database_url"
    )
  );
  if (
    migration.host !== runtime.host ||
    migration.port !== runtime.port ||
    migration.database !== runtime.database
  ) {
    postgresFail(
      "vault_rotation_database_target_mismatch",
      "Destinos PostgreSQL do operador divergem."
    );
  }
  if (
    !migration.password ||
    !runtime.password ||
    migration.username === runtime.username ||
    secretsEqual(migration.password, runtime.password)
  ) {
    postgresFail(
      "vault_rotation_database_credentials_not_separated",
      "Credenciais PostgreSQL do operador devem ser separadas."
    );
  }
  return Object.freeze({
    migrationLogin: migration.username,
    runtimeLogin: runtime.username
  });
}

function clearParsedKeyring(keyring) {
  if (!keyring?.keys || !(keyring.keys instanceof Map)) return;
  for (const key of keyring.keys.values()) {
    if (Buffer.isBuffer(key)) key.fill(0);
  }
  keyring.keys.clear();
}

function loadVaultRotationOperatorConfig(
  env = process.env,
  request = {}
) {
  assertNoAmbientPostgresEnvironment(
    env,
    "vault_rotation_postgres_environment_override_forbidden"
  );
  const mode = requireMode(request.mode);
  const retire = request.retire === true;
  if (retire && mode !== "rotate") {
    postgresFail(
      "vault_rotation_arguments_invalid",
      "Argumentos do operador recusados."
    );
  }
  const environment = requireSafeLabel(
    env.SOCIAL_VAULT_ROTATION_ENVIRONMENT,
    "vault_rotation_environment"
  ).toLowerCase();
  if (!["local", "test", "staging", "production"].includes(environment)) {
    postgresFail(
      "vault_rotation_environment_invalid",
      "Ambiente do operador recusado."
    );
  }
  const environmentId = requireUuid(
    env.SOCIAL_VAULT_ROTATION_EXPECTED_ENVIRONMENT_ID,
    "vault_rotation_expected_environment_id"
  );
  requireExactApproval(env, mode, retire, environmentId);
  if (
    environment === "production" &&
    mode !== "inventory" &&
    env.SOCIAL_VAULT_ROTATION_PRODUCTION_APPROVAL !==
      PRODUCTION_ROTATION_APPROVAL
  ) {
    postgresFail(
      "vault_rotation_production_not_approved",
      "Rotacao de producao recusada."
    );
  }

  const migrationDatabaseUrl =
    env.SOCIAL_VAULT_ROTATION_MIGRATIONS_DATABASE_URL;
  const runtimeDatabaseUrl =
    env.SOCIAL_VAULT_ROTATION_RUNTIME_DATABASE_URL;
  const identities = assertSeparateDatabaseCredentials(
    migrationDatabaseUrl,
    runtimeDatabaseUrl
  );
  const expectedMigrationLogin = requireSafeLabel(
    env.SOCIAL_VAULT_ROTATION_EXPECTED_MIGRATION_LOGIN,
    "vault_rotation_expected_migration_login"
  );
  const expectedRuntimeLogin = requireSafeLabel(
    env.SOCIAL_VAULT_ROTATION_EXPECTED_RUNTIME_LOGIN,
    "vault_rotation_expected_runtime_login"
  );
  if (
    expectedMigrationLogin !== expectedMigrationLogin.toLowerCase() ||
    expectedRuntimeLogin !== expectedRuntimeLogin.toLowerCase() ||
    identities.migrationLogin !== expectedMigrationLogin ||
    identities.runtimeLogin !== expectedRuntimeLogin
  ) {
    postgresFail(
      "vault_rotation_database_login_mismatch",
      "Login PostgreSQL do operador diverge."
    );
  }

  const shared = {
    NODE_ENV: env.NODE_ENV,
    SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST:
      env.NODE_ENV === "test"
        ? env.SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST
        : undefined,
    SOCIAL_DATABASE_CA_BASE64:
      env.SOCIAL_VAULT_ROTATION_DATABASE_CA_BASE64,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      env.SOCIAL_VAULT_ROTATION_EXPECTED_TARGET_FINGERPRINT,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: expectedRuntimeLogin
  };
  const migration = loadMigrationPostgresConfig({
    ...shared,
    SOCIAL_MIGRATIONS_DATABASE_URL: migrationDatabaseUrl,
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: expectedMigrationLogin,
    SOCIAL_MIGRATION_ENVIRONMENT: environment,
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: environmentId
  });
  const runtime = loadRuntimePostgresConfig({
    ...shared,
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL: runtimeDatabaseUrl
  });
  if (migration.targetFingerprint !== runtime.targetFingerprint) {
    postgresFail(
      "vault_rotation_database_target_mismatch",
      "Destinos PostgreSQL do operador divergem."
    );
  }

  const keyring = parseVaultKeyring({
    SOCIAL_VAULT_ACTIVE_KEY_VERSION:
      env.SOCIAL_VAULT_ROTATION_ACTIVE_KEY_VERSION,
    SOCIAL_VAULT_KEYS_JSON:
      env.SOCIAL_VAULT_ROTATION_KEYS_JSON,
    SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT:
      env.SOCIAL_VAULT_ROTATION_EXPECTED_KEYRING_FINGERPRINT
  });
  try {
    const rawExpected = String(
      env.SOCIAL_VAULT_ROTATION_EXPECTED_CURRENT_KEY_VERSION || ""
    );
    const expectedCurrentKeyVersion =
      rawExpected === UNINITIALIZED_AUTHORITY
        ? null
        : requireVaultKeyVersion(rawExpected);
    if (
      expectedCurrentKeyVersion &&
      !keyring.keys.has(expectedCurrentKeyVersion)
    ) {
      postgresFail(
        "vault_rotation_expected_key_unavailable",
        "Chave atual esperada nao esta legivel."
      );
    }

    const retirementConfigured = hasValue(
      env.SOCIAL_VAULT_ROTATION_RETIRE_KEY_VERSION
    );
    if (retirementConfigured !== retire) {
      postgresFail(
        "vault_rotation_retirement_configuration_invalid",
        "Configuracao de retirada recusada."
      );
    }
    const retireKeyVersion = retire
      ? requireVaultKeyVersion(
          env.SOCIAL_VAULT_ROTATION_RETIRE_KEY_VERSION
        )
      : null;
    if (
      retire &&
      (
        !expectedCurrentKeyVersion ||
        retireKeyVersion !== expectedCurrentKeyVersion ||
        retireKeyVersion === keyring.activeVersion ||
        !keyring.keys.has(retireKeyVersion)
      )
    ) {
      postgresFail(
        "vault_rotation_retirement_configuration_invalid",
        "Configuracao de retirada recusada."
      );
    }

    return Object.freeze({
      mode,
      retire,
      batchSize: requireBatchSize(
        env.SOCIAL_VAULT_ROTATION_BATCH_SIZE
      ),
      environment,
      environmentId,
      expectedCurrentKeyVersion,
      retireKeyVersion,
      identityDerivationVersion: requireKeyVersion(
        env.SOCIAL_VAULT_ROTATION_IDENTITY_DERIVATION_VERSION
      ),
      expectedKeyringFingerprint:
        env.SOCIAL_VAULT_ROTATION_EXPECTED_KEYRING_FINGERPRINT,
      keyring,
      migration,
      runtime
    });
  } catch (error) {
    clearParsedKeyring(keyring);
    throw error;
  }
}

async function verifyVaultRotationDatabaseBoundaries(
  config,
  migrationPool,
  runtimePool
) {
  if (
    !config ||
    !migrationPool ||
    !runtimePool ||
    typeof migrationPool.connect !== "function" ||
    typeof runtimePool.connect !== "function"
  ) {
    postgresFail(
      "vault_rotation_database_boundary_invalid",
      "Boundary PostgreSQL do operador recusado."
    );
  }
  const migrationState = await createMigrationRunner({
    pool: migrationPool,
    ownerRole: config.migration.ownerRole,
    migratorRole: config.migration.migratorRole,
    target: config.migration.target
  }).validate();
  if (
    migrationState?.valid !== true ||
    migrationState.pending !== 0 ||
    !Number.isSafeInteger(migrationState.applied) ||
    migrationState.applied < 1
  ) {
    postgresFail(
      "vault_rotation_schema_not_current",
      "Schema PostgreSQL do operador divergente."
    );
  }
  await verifyRuntimeRole(runtimePool, config.runtime.role);
  await verifyRuntimeSchema(runtimePool, config.runtime.role);
  return Object.freeze({
    migration: true,
    runtime: true,
    environment: true
  });
}

function createVaultRotationOperator(options = {}) {
  const keyRegistryAdmin = options.keyRegistryAdmin;
  const rotationService = options.rotationService;
  const vault = options.vault;
  const logger = options.logger;
  const batchSize = requireBatchSize(options.batchSize);
  const expectedCurrentKeyVersion =
    options.expectedCurrentKeyVersion === null
      ? null
      : requireVaultKeyVersion(options.expectedCurrentKeyVersion);
  const targetKeyVersion = requireVaultKeyVersion(
    options.targetKeyVersion
  );
  const expectedKeyringFingerprint = String(
    options.expectedKeyringFingerprint || ""
  );

  if (
    !keyRegistryAdmin ||
    typeof keyRegistryAdmin.currentAuthority !== "function" ||
    typeof keyRegistryAdmin.listCredentialInventoryPage !== "function" ||
    typeof keyRegistryAdmin.register !== "function" ||
    typeof keyRegistryAdmin.withActiveVersion !== "function"
  ) {
    postgresFail(
      "vault_rotation_registry_admin_required",
      "Autoridade administrativa do cofre obrigatoria."
    );
  }
  if (
    !rotationService ||
    typeof rotationService.rotateTenant !== "function" ||
    typeof rotationService.retire !== "function"
  ) {
    postgresFail(
      "vault_rotation_service_required",
      "Servico de rotacao obrigatorio."
    );
  }
  if (!vault || typeof vault.versions !== "function") {
    postgresFail("social_vault_required", "Cofre social obrigatorio.");
  }
  if (
    logger !== undefined &&
    (!logger ||
      (typeof logger.info !== "function" &&
        typeof logger.warn !== "function"))
  ) {
    postgresFail(
      "vault_rotation_logger_invalid",
      "Logger do operador recusado."
    );
  }

  function log(level, event, details = {}) {
    const operation = logger?.[level];
    if (typeof operation !== "function") return;
    try {
      const outcome = operation.call(
        logger,
        Object.freeze({
          component: "social_vault_rotation_operator",
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

  function assertKeyring() {
    let versions;
    try {
      versions = vault.versions();
      assertVaultKeyringFingerprint(
        versions?.fingerprint,
        expectedKeyringFingerprint
      );
    } catch {
      postgresFail(
        "vault_rotation_keyring_invalid",
        "Conjunto de chaves do operador recusado."
      );
    }
    if (
      versions.active !== targetKeyVersion ||
      !Array.isArray(versions.readable) ||
      !versions.readable.includes(targetKeyVersion) ||
      (
        expectedCurrentKeyVersion &&
        !versions.readable.includes(expectedCurrentKeyVersion)
      )
    ) {
      postgresFail(
        "vault_rotation_keyring_invalid",
        "Conjunto de chaves do operador recusado."
      );
    }
    return true;
  }

  async function assertAuthority() {
    const authority = await keyRegistryAdmin.currentAuthority();
    if (authority === null) {
      if (expectedCurrentKeyVersion !== null) {
        postgresFail(
          "vault_rotation_authority_mismatch",
          "Autoridade do cofre diverge."
        );
      }
      return Object.freeze({ initialized: false, targetActive: false });
    }
    const active = requireVaultKeyVersion(
      authority.activeKeyVersion
    );
    requirePositiveInteger(
      authority.generation,
      "vault_key_generation"
    );
    if (
      active !== expectedCurrentKeyVersion &&
      active !== targetKeyVersion
    ) {
      postgresFail(
        "vault_rotation_authority_mismatch",
        "Autoridade do cofre diverge."
      );
    }
    return Object.freeze({
      initialized: true,
      targetActive: active === targetKeyVersion
    });
  }

  async function scan({ rotate = false } = {}) {
    let cursor = null;
    let previousCompanyId = null;
    let pages = 0;
    let companies = 0;
    let credentials = 0;
    let current = 0;
    let pending = 0;
    let changed = 0;
    let alreadyCurrent = 0;
    let batches = 0;

    for (;;) {
      const page =
        await keyRegistryAdmin.listCredentialInventoryPage({
          cursor,
          limit: batchSize,
          targetKeyVersion
        });
      if (
        !page ||
        !Array.isArray(page.entries) ||
        typeof page.complete !== "boolean"
      ) {
        postgresFail(
          "vault_inventory_result_invalid",
          "Resultado do inventario recusado."
        );
      }
      pages += 1;
      const groups = [];
      for (const entry of page.entries) {
        if (!entry || typeof entry.isTargetKey !== "boolean") {
          postgresFail(
            "vault_inventory_result_invalid",
            "Resultado do inventario recusado."
          );
        }
        const companyId = requireUuid(entry.companyId, "company_id");
        const credentialId = requireUuid(
          entry.credentialId,
          "credential_id"
        );
        credentials += 1;
        if (companyId !== previousCompanyId) {
          companies += 1;
          previousCompanyId = companyId;
        }
        if (entry.isTargetKey) {
          current += 1;
          continue;
        }
        pending += 1;
        if (!rotate) continue;
        let group = groups.at(-1);
        if (!group || group.companyId !== companyId) {
          group = {
            companyId,
            credentialIds: []
          };
          groups.push(group);
        }
        group.credentialIds.push(credentialId);
      }

      for (const group of groups) {
        const result = await rotationService.rotateTenant({
          companyId: group.companyId,
          keyVersion: targetKeyVersion,
          expectedActiveKeyVersion: expectedCurrentKeyVersion,
          credentialIds: group.credentialIds
        });
        if (
          !result ||
          result.credentials !== group.credentialIds.length ||
          !Number.isSafeInteger(result.changed) ||
          !Number.isSafeInteger(result.alreadyCurrent) ||
          result.changed + result.alreadyCurrent !== result.credentials
        ) {
          postgresFail(
            "vault_rotation_result_invalid",
            "Resultado da rotacao recusado."
          );
        }
        changed += result.changed;
        alreadyCurrent += result.alreadyCurrent;
        batches += 1;
        log("info", "batch_complete", {
          batch: batches,
          credentials: result.credentials,
          changed: result.changed,
          alreadyCurrent: result.alreadyCurrent
        });
      }

      if (page.complete) break;
      if (
        !page.nextCursor ||
        typeof page.nextCursor.companyId !== "string" ||
        typeof page.nextCursor.credentialId !== "string"
      ) {
        postgresFail(
          "vault_inventory_cursor_invalid",
          "Cursor do inventario recusado."
        );
      }
      cursor = page.nextCursor;
    }

    return Object.freeze({
      pages,
      companies,
      credentials,
      current,
      pending,
      changed,
      alreadyCurrent,
      batches
    });
  }

  async function inventory() {
    assertKeyring();
    await assertAuthority();
    const result = await scan();
    log("info", "inventory_complete", result);
    return Object.freeze({
      mode: "inventory",
      ...result
    });
  }

  async function prepare() {
    assertKeyring();
    const authorityBefore = await assertAuthority();
    if (authorityBefore.targetActive) {
      postgresFail(
        "vault_prepare_target_already_active",
        "Preparacao recusada para chave ja ativa."
      );
    }
    const registration = await keyRegistryAdmin.register({
      keyVersion: targetKeyVersion
    });
    if (
      registration?.keyVersion !== targetKeyVersion ||
      typeof registration?.registered !== "boolean"
    ) {
      postgresFail(
        "vault_key_registration_unconfirmed",
        "Registro da chave alvo nao confirmado."
      );
    }
    const authorityAfter = await assertAuthority();
    if (
      authorityAfter.initialized !== authorityBefore.initialized ||
      authorityAfter.targetActive !== authorityBefore.targetActive
    ) {
      postgresFail(
        "vault_prepare_authority_changed",
        "Autoridade do cofre mudou durante a preparacao."
      );
    }
    const result = Object.freeze({
      mode: "prepare",
      registered: registration.registered
    });
    log("info", "target_registered", {
      registered: result.registered
    });
    return result;
  }

  async function rotate({ retireKeyVersion = null } = {}) {
    assertKeyring();
    await assertAuthority();
    const registration = await keyRegistryAdmin.register({
      keyVersion: targetKeyVersion
    });
    if (
      registration?.keyVersion !== targetKeyVersion ||
      typeof registration?.registered !== "boolean"
    ) {
      postgresFail(
        "vault_key_registration_unconfirmed",
        "Registro da chave ativa nao confirmado."
      );
    }
    const activation = await keyRegistryAdmin.withActiveVersion(
      {
        keyVersion: targetKeyVersion,
        expectedActiveKeyVersion: expectedCurrentKeyVersion
      },
      async (authority) => {
        if (
          authority?.activeKeyVersion !== targetKeyVersion ||
          !Number.isSafeInteger(authority?.generation) ||
          authority.generation < 1
        ) {
          postgresFail(
            "vault_key_authority_invalid",
            "Autoridade global de chave divergente."
          );
        }
        return true;
      }
    );
    if (
      activation?.authority?.activeKeyVersion !== targetKeyVersion ||
      activation?.result !== true
    ) {
      postgresFail(
        "vault_key_authority_invalid",
        "Autoridade global de chave divergente."
      );
    }
    log("info", "target_ready", {
      newlyRegistered: registration.registered,
      newlyActivated: activation.authority.activated === true
    });

    const attempted = await scan({ rotate: true });
    const verified = await scan();
    if (verified.pending !== 0) {
      postgresFail(
        "vault_rotation_incomplete",
        "Rotacao do cofre permanece incompleta."
      );
    }

    let retired = false;
    if (retireKeyVersion !== null) {
      const version = requireVaultKeyVersion(retireKeyVersion);
      if (
        version !== expectedCurrentKeyVersion ||
        version === targetKeyVersion
      ) {
        postgresFail(
          "vault_rotation_retirement_configuration_invalid",
          "Configuracao de retirada recusada."
        );
      }
      const retirement = await rotationService.retire({
        keyVersion: version
      });
      if (
        retirement?.keyVersion !== version ||
        typeof retirement?.retired !== "boolean"
      ) {
        postgresFail(
          "vault_key_retirement_unconfirmed",
          "Retirada da chave nao confirmada."
        );
      }
      retired = retirement.retired;
    }
    const finalAuthority = await assertAuthority();
    if (!finalAuthority.targetActive) {
      postgresFail(
        "vault_rotation_authority_mismatch",
        "Autoridade do cofre diverge."
      );
    }
    const result = Object.freeze({
      mode: "rotate",
      pages: attempted.pages,
      companies: attempted.companies,
      credentials: attempted.credentials,
      pendingBefore: attempted.pending,
      changed: attempted.changed,
      alreadyCurrent: attempted.alreadyCurrent,
      batches: attempted.batches,
      pendingAfter: verified.pending,
      retired
    });
    log("info", "rotation_complete", result);
    return result;
  }

  return Object.freeze({ inventory, prepare, rotate });
}

function safeCliLogger(stream) {
  const SAFE_COMPONENTS = new Set([
    "social_postgres",
    "social_vault_rotation",
    "social_vault_rotation_operator"
  ]);
  const SAFE_EVENTS = new Set([
    "active_key_ready",
    "batch_complete",
    "credential_revision_conflict",
    "inventory_complete",
    "key_retired",
    "rotation_complete",
    "target_registered",
    "target_ready",
    "tenant_rotation_complete"
  ]);
  const SAFE_DETAIL_NAMES = new Set([
    "alreadyCurrent",
    "attempt",
    "batch",
    "batches",
    "changed",
    "companies",
    "credentials",
    "current",
    "generation",
    "newlyActivated",
    "newlyRegistered",
    "pages",
    "pending",
    "pendingAfter",
    "pendingBefore",
    "registered",
    "retired"
  ]);
  function safeDetails(entry) {
    const details = {};
    for (const [name, value] of Object.entries(entry || {})) {
      if (
        SAFE_DETAIL_NAMES.has(name) &&
        (
          typeof value === "boolean" ||
          (Number.isSafeInteger(value) && value >= 0)
        )
      ) {
        details[name] = value;
      }
    }
    return details;
  }
  return Object.freeze({
    info(entry) {
      stream.write(
        `${JSON.stringify({
          level: "info",
          component: SAFE_COMPONENTS.has(entry?.component)
            ? entry.component
            : "social_vault_rotation_operator",
          event: SAFE_EVENTS.has(entry?.event)
            ? entry.event
            : "event_redacted",
          ...safeDetails(entry)
        })}\n`
      );
    },
    warn(entry) {
      stream.write(
        `${JSON.stringify({
          level: "warn",
          component: SAFE_COMPONENTS.has(entry?.component)
            ? entry.component
            : "social_vault_rotation_operator",
          event: SAFE_EVENTS.has(entry?.event)
            ? entry.event
            : "event_redacted"
        })}\n`
      );
    }
  });
}

async function runVaultRotationFromEnvironment(options = {}) {
  const env = options.env || process.env;
  const request = options.request;
  const config = loadVaultRotationOperatorConfig(env, request);
  const PoolClass = options.PoolClass;
  const logger = options.logger;
  let migrationPool;
  let runtimePool;
  let vault;
  let primaryError;
  try {
    migrationPool = createPostgresPool(config.migration.pool, {
      PoolClass,
      logger
    });
    runtimePool = createPostgresPool(config.runtime.pool, {
      PoolClass,
      logger
    });
    await verifyVaultRotationDatabaseBoundaries(
      config,
      migrationPool,
      runtimePool
    );
    const keyRegistryAdmin = createVaultKeyRegistryAdmin({
      pool: migrationPool,
      ownerRole: config.migration.ownerRole
    });
    const repository = createSocialRepository({
      pool: runtimePool,
      runtimeRole: config.runtime.role,
      identityDerivationVersion: config.identityDerivationVersion
    });
    vault = createSocialVault({
      keyring: config.keyring,
      expectedKeyringFingerprint: config.expectedKeyringFingerprint
    });
    clearParsedKeyring(config.keyring);
    const credentialService = createSocialCredentialService({
      repository,
      vault
    });
    const rotationService = createVaultKeyRotationService({
      credentialService,
      keyRegistryAdmin,
      vault,
      logger
    });
    const operator = createVaultRotationOperator({
      keyRegistryAdmin,
      rotationService,
      vault,
      logger,
      batchSize: config.batchSize,
      targetKeyVersion: config.keyring.activeVersion,
      expectedCurrentKeyVersion: config.expectedCurrentKeyVersion,
      expectedKeyringFingerprint: config.expectedKeyringFingerprint
    });
    if (config.mode === "inventory") {
      return await operator.inventory();
    }
    if (config.mode === "prepare") {
      return await operator.prepare();
    }
    return await operator.rotate({
      retireKeyVersion: config.retireKeyVersion
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    clearParsedKeyring(config.keyring);
    if (vault) vault.destroy();
    const pools = [runtimePool, migrationPool].filter(Boolean);
    const cleanup = await Promise.allSettled(
      pools.map((pool) => closePostgresPool(pool))
    );
    if (
      !primaryError &&
      cleanup.some((result) => result.status === "rejected")
    ) {
      postgresFail(
        "vault_rotation_cleanup_failed",
        "Encerramento do operador nao confirmado."
      );
    }
  }
}

async function runVaultRotationCli(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  try {
    const request = parseVaultRotationArguments(
      options.argv || process.argv.slice(2)
    );
    const execute =
      options.execute || runVaultRotationFromEnvironment;
    if (typeof execute !== "function") {
      postgresFail(
        "vault_rotation_executor_invalid",
        "Executor do operador recusado."
      );
    }
    const result = await execute({
      env: options.env || process.env,
      request,
      PoolClass: options.PoolClass,
      logger: options.logger || safeCliLogger(stderr)
    });
    const safeResult = { ok: true };
    for (const [name, value] of Object.entries(result || {})) {
      if (
        name === "mode" &&
        ["inventory", "prepare", "rotate"].includes(value)
      ) {
        safeResult.mode = value;
      } else if (
        [
          "alreadyCurrent",
          "batches",
          "changed",
          "companies",
          "credentials",
          "current",
          "pages",
          "pending",
          "pendingAfter",
          "pendingBefore"
        ].includes(name) &&
        Number.isSafeInteger(value) &&
        value >= 0
      ) {
        safeResult[name] = value;
      } else if (
        ["registered", "retired"].includes(name) &&
        typeof value === "boolean"
      ) {
        safeResult[name] = value;
      }
    }
    stdout.write(`${JSON.stringify(safeResult)}\n`);
    return 0;
  } catch (error) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: "vault_rotation_failed"
      })}\n`
    );
    return 1;
  }
}

module.exports = {
  DEFAULT_OPERATOR_BATCH_SIZE,
  MAX_OPERATOR_BATCH_SIZE,
  OPERATOR_ENVIRONMENT_NAMES,
  PRODUCTION_ROTATION_APPROVAL,
  UNINITIALIZED_AUTHORITY,
  assertSeparateDatabaseCredentials,
  clearParsedKeyring,
  createVaultRotationOperator,
  loadVaultRotationOperatorConfig,
  parseVaultRotationArguments,
  requireBatchSize,
  requireExactApproval,
  runVaultRotationCli,
  runVaultRotationFromEnvironment,
  safeCliLogger,
  verifyVaultRotationDatabaseBoundaries
};
