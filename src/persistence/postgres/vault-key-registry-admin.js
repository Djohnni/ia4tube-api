"use strict";

const crypto = require("node:crypto");
const { postgresFail, SocialPostgresError } = require("./errors");
const {
  requirePositiveInteger,
  requireSafeLabel,
  requireUuid
} = require("./validation");
const {
  parseVaultKeyVersion,
  requireVaultKeyVersion
} = require("../../social/vault-key-version");

const SOCIAL_OWNER_ROLE = "ia4tube_social_owner";
const VAULT_KEY_REGISTRY =
  "ia4tube_social_admin.vault_key_versions";
const CREDENTIAL_KEY_FOREIGN_KEY =
  "social_encrypted_credentials_key_version_fk";
const CREDENTIAL_INVENTORY_POLICY =
  "social_credentials_key_rotation_inventory";
const VAULT_ROTATION_LOCK_ID = "71127468820260729";
const MAX_CREDENTIAL_INVENTORY_PAGE_SIZE = 250;
const VAULT_AUTHORITY_MARKER_PREFIX = "ia.";
const ACTIVE_MARKER_PREFIX = "ia.a.";
const RETIREMENT_MARKER_PREFIX = "ia.r.";
const VERSION_DIGEST_BYTES = 24;
const VERSION_DIGEST_PATTERN = "[A-Za-z0-9_-]{32}";
const VERSION_DIGEST_REGEX = new RegExp(
  `^${VERSION_DIGEST_PATTERN}$`
);
const ACTIVE_MARKER_PATTERN = new RegExp(
  `^ia\\.a\\.([0-9a-z]{1,11})\\.(${VERSION_DIGEST_PATTERN})$`
);
const RETIREMENT_MARKER_PATTERN = new RegExp(
  `^ia\\.r\\.(${VERSION_DIGEST_PATTERN})$`
);

function requireOperationalKeyVersion(value) {
  return requireVaultKeyVersion(value);
}

function versionDigest(version) {
  const safeVersion = requireOperationalKeyVersion(version);
  return crypto
    .createHash("sha256")
    .update("ia4tube:vault-key-version:v1\0", "utf8")
    .update(safeVersion, "utf8")
    .digest()
    .subarray(0, VERSION_DIGEST_BYTES)
    .toString("base64url");
}

function decodeGeneration(value) {
  let generation = 0n;
  for (const character of value) {
    const digit = BigInt(parseInt(character, 36));
    generation = generation * 36n + digit;
  }
  if (
    generation < 1n ||
    generation > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    postgresFail(
      "vault_key_authority_corrupt",
      "Autoridade global de chave inconsistente."
    );
  }
  return Number(generation);
}

function encodeGeneration(value) {
  const generation = requirePositiveInteger(
    value,
    "vault_key_generation"
  );
  const encoded = generation.toString(36);
  if (encoded.length > 11) {
    postgresFail(
      "vault_key_generation_exhausted",
      "Geracao global de chave esgotada."
    );
  }
  return encoded;
}

function activeMarker(generation, digest) {
  return `${ACTIVE_MARKER_PREFIX}${encodeGeneration(generation)}.${digest}`;
}

function retirementMarker(digest) {
  return `${RETIREMENT_MARKER_PREFIX}${digest}`;
}

function corruptAuthority() {
  postgresFail(
    "vault_key_authority_corrupt",
    "Autoridade global de chave inconsistente."
  );
}

function requireInventoryPageSize(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CREDENTIAL_INVENTORY_PAGE_SIZE
  ) {
    postgresFail(
      "vault_inventory_page_size_invalid",
      "Tamanho da pagina de inventario recusado."
    );
  }
  return value;
}

function requireInventoryCursor(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    postgresFail(
      "vault_inventory_cursor_invalid",
      "Cursor do inventario recusado."
    );
  }
  return Object.freeze({
    companyId: requireUuid(value.companyId, "company_id"),
    credentialId: requireUuid(
      value.credentialId,
      "credential_id"
    )
  });
}

function compareInventoryEntries(left, right) {
  if (left.companyId < right.companyId) return -1;
  if (left.companyId > right.companyId) return 1;
  if (left.credentialId < right.credentialId) return -1;
  if (left.credentialId > right.credentialId) return 1;
  return 0;
}

function parseRegistryRows(rows, options = {}) {
  if (!Array.isArray(rows)) corruptAuthority();

  const digestVersion =
    typeof options.versionDigest === "function"
      ? options.versionDigest
      : versionDigest;
  const activations = [];
  const activationGenerations = new Set();
  const activationDigests = new Set();
  const operationalByDigest = new Map();
  const operationalVersions = new Set();
  const retiredDigests = new Set();

  for (const row of rows) {
    const keyVersion = row?.key_version;
    if (
      typeof keyVersion !== "string" ||
      keyVersion !== keyVersion.trim()
    ) {
      corruptAuthority();
    }
    if (!keyVersion.startsWith(VAULT_AUTHORITY_MARKER_PREFIX)) {
      requireOperationalKeyVersion(keyVersion);
      const digest = digestVersion(keyVersion);
      if (
        typeof digest !== "string" ||
        !VERSION_DIGEST_REGEX.test(digest)
      ) {
        corruptAuthority();
      }
      const existing = operationalByDigest.get(digest);
      if (existing && existing !== keyVersion) {
        postgresFail(
          "vault_key_version_digest_collision",
          "Colisao de identificador de chave recusada."
        );
      }
      operationalByDigest.set(digest, keyVersion);
      operationalVersions.add(keyVersion);
      continue;
    }

    let match = ACTIVE_MARKER_PATTERN.exec(keyVersion);
    if (match) {
      const generation = decodeGeneration(match[1]);
      const digest = match[2];
      if (
        activationGenerations.has(generation) ||
        activationDigests.has(digest)
      ) {
        corruptAuthority();
      }
      activationGenerations.add(generation);
      activationDigests.add(digest);
      activations.push(
        Object.freeze({
          digest,
          generation,
          marker: keyVersion,
          registeredAt: row.registered_at
        })
      );
      continue;
    }

    match = RETIREMENT_MARKER_PATTERN.exec(keyVersion);
    if (match) {
      retiredDigests.add(match[1]);
      continue;
    }
    corruptAuthority();
  }

  activations.sort((left, right) => left.generation - right.generation);
  activations.forEach((entry, index) => {
    if (entry.generation !== index + 1) corruptAuthority();
  });
  const current = activations.at(-1) || null;
  if (current && !operationalByDigest.has(current.digest)) {
    corruptAuthority();
  }
  for (const digest of retiredDigests) {
    if (operationalByDigest.has(digest)) corruptAuthority();
  }

  return Object.freeze({
    active: current,
    activations: Object.freeze(activations),
    activationDigests,
    operationalByDigest,
    operationalVersions,
    retiredDigests
  });
}

function createVaultKeyRegistryAdmin(options = {}) {
  const pool = options.pool;
  const ownerRole = requireSafeLabel(
    options.ownerRole || SOCIAL_OWNER_ROLE,
    "postgres_owner_role"
  );
  if (ownerRole !== SOCIAL_OWNER_ROLE) {
    postgresFail(
      "vault_key_admin_role_must_be_canonical",
      "Role administrativa do cofre recusada."
    );
  }
  if (!pool || typeof pool.connect !== "function") {
    postgresFail("postgres_pool_required", "Pool PostgreSQL obrigatorio.");
  }
  const unsafeClients = new WeakSet();

  async function ownerTransaction(client, operation) {
    let started = false;
    try {
      await client.query("BEGIN");
      started = true;
      await client.query('SET LOCAL ROLE "ia4tube_social_owner"');
      const result = await operation(client);
      await client.query("COMMIT");
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          await client.query("ROLLBACK");
        } catch {
          unsafeClients.add(client);
          throw new SocialPostgresError(
            "vault_key_admin_rollback_failed",
            "Rollback administrativo do cofre nao confirmado.",
            error
          );
        }
      }
      throw error;
    }
  }

  async function withRotationBarrier(operation) {
    if (typeof operation !== "function") {
      postgresFail(
        "vault_rotation_operation_required",
        "Operacao administrativa do cofre obrigatoria."
      );
    }
    const client = await pool.connect();
    let locked = false;
    let primaryError;
    let unlockError;
    try {
      await client.query(
        "SELECT pg_advisory_lock($1::bigint)",
        [VAULT_ROTATION_LOCK_ID]
      );
      locked = true;
      return await operation(client);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (locked) {
        try {
          const unlocked = await client.query(
            "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
            [VAULT_ROTATION_LOCK_ID]
          );
          if (unlocked.rows?.[0]?.unlocked !== true) {
            unlockError = new Error("vault rotation lock not released");
          }
        } catch (error) {
          unlockError = error;
        }
      }
      client.release(
        unlockError ||
          (unsafeClients.has(client) ? primaryError : undefined)
      );
      if (unlockError && !primaryError) {
        throw new SocialPostgresError(
          "vault_rotation_unlock_failed",
          "Barreira administrativa do cofre nao foi liberada."
        );
      }
    }
  }

  async function readRegistryState(client) {
    const result = await client.query(
      [
        "SELECT key_version, registered_at",
        `FROM ${VAULT_KEY_REGISTRY}`,
        "ORDER BY key_version",
        "FOR UPDATE"
      ].join("\n")
    );
    return parseRegistryRows(result.rows);
  }

  async function insertMarker(client, marker) {
    const result = await client.query(
      [
        `INSERT INTO ${VAULT_KEY_REGISTRY} (key_version)`,
        "VALUES ($1)",
        "RETURNING key_version, registered_at"
      ].join("\n"),
      [marker]
    );
    if (result.rowCount !== 1) corruptAuthority();
    return result.rows?.[0];
  }

  async function register({ keyVersion } = {}) {
    const version = requireOperationalKeyVersion(keyVersion);
    const digest = versionDigest(version);
    return withRotationBarrier((client) =>
      ownerTransaction(client, async (transaction) => {
        const state = await readRegistryState(transaction);
        if (
          state.retiredDigests.has(digest) ||
          (state.activationDigests.has(digest) &&
            !state.operationalVersions.has(version))
        ) {
          postgresFail(
            "vault_key_version_retired",
            "Versao de chave aposentada."
          );
        }
        const result = await transaction.query(
          [
            `INSERT INTO ${VAULT_KEY_REGISTRY} (key_version)`,
            "VALUES ($1)",
            "ON CONFLICT (key_version) DO NOTHING",
            "RETURNING key_version"
          ].join("\n"),
          [version]
        );
        return Object.freeze({
          keyVersion: version,
          registered: result.rowCount === 1
        });
      })
    );
  }

  async function withActiveVersion(input = {}, operation) {
    const version = requireOperationalKeyVersion(input.keyVersion);
    const expected =
      input.expectedActiveKeyVersion === undefined ||
      input.expectedActiveKeyVersion === null
        ? null
        : requireOperationalKeyVersion(input.expectedActiveKeyVersion);
    if (typeof operation !== "function") {
      postgresFail(
        "vault_rotation_operation_required",
        "Operacao administrativa do cofre obrigatoria."
      );
    }
    const digest = versionDigest(version);
    const expectedDigest = expected ? versionDigest(expected) : null;

    return withRotationBarrier(async (client) => {
      const authority = await ownerTransaction(
        client,
        async (transaction) => {
          const state = await readRegistryState(transaction);
          if (state.retiredDigests.has(digest)) {
            postgresFail(
              "vault_key_version_retired",
              "Versao de chave aposentada."
            );
          }
          if (!state.operationalVersions.has(version)) {
            postgresFail(
              "vault_key_version_not_registered",
              "Versao de chave nao registrada."
            );
          }
          if (state.active?.digest === digest) {
            return Object.freeze({
              activeKeyVersion: version,
              generation: state.active.generation,
              activated: false
            });
          }
          if (!state.active && expected !== null) {
            postgresFail(
              "vault_key_authority_uninitialized",
              "Autoridade global de chave nao inicializada."
            );
          }
          if (
            state.active &&
            (expectedDigest === null ||
              state.active.digest !== expectedDigest)
          ) {
            postgresFail(
              "vault_key_activation_conflict",
              "Versao ativa global divergente."
            );
          }
          if (state.activationDigests.has(digest)) {
            postgresFail(
              "vault_key_activation_downgrade",
              "Reativacao de chave antiga recusada."
            );
          }
          if (state.active) {
            const currentVersion = state.operationalByDigest.get(
              state.active.digest
            );
            if (
              parseVaultKeyVersion(version).generation <=
              parseVaultKeyVersion(currentVersion).generation
            ) {
              postgresFail(
                "vault_key_activation_generation_not_monotonic",
                "Geracao da chave ativa deve avancar."
              );
            }
          }

          const generation = state.active
            ? state.active.generation + 1
            : 1;
          const active = activeMarker(generation, digest);
          const activationRow = await insertMarker(
            transaction,
            active
          );
          return Object.freeze({
            activeKeyVersion: version,
            generation,
            activated: true,
            activatedAt: activationRow?.registered_at
          });
        }
      );
      const result = await operation(authority);
      return Object.freeze({ authority, result });
    });
  }

  async function currentAuthority() {
    return withRotationBarrier((client) =>
      ownerTransaction(client, async (transaction) => {
        const state = await readRegistryState(transaction);
        if (!state.active) return null;
        const activeKeyVersion = state.operationalByDigest.get(
          state.active.digest
        );
        if (!activeKeyVersion) corruptAuthority();
        return Object.freeze({
          activeKeyVersion,
          generation: state.active.generation,
          activatedAt: state.active.registeredAt
        });
      })
    );
  }

  async function withCredentialInventoryPolicy(operation) {
    if (typeof operation !== "function") {
      postgresFail(
        "vault_inventory_operation_required",
        "Operacao de inventario obrigatoria."
      );
    }
    return withRotationBarrier((client) =>
      ownerTransaction(client, async (transaction) => {
        const existing = await transaction.query(
          [
            "SELECT COUNT(*)::integer AS policy_count",
            "FROM pg_catalog.pg_policy policy",
            "JOIN pg_catalog.pg_class relation",
            "  ON relation.oid = policy.polrelid",
            "JOIN pg_catalog.pg_namespace namespace",
            "  ON namespace.oid = relation.relnamespace",
            "WHERE namespace.nspname = 'ia4tube_social'",
            "  AND relation.relname = 'social_encrypted_credentials'",
            "  AND policy.polname = $1"
          ].join("\n"),
          [CREDENTIAL_INVENTORY_POLICY]
        );
        if (
          existing.rows?.length !== 1 ||
          Number(existing.rows[0].policy_count) !== 0
        ) {
          postgresFail(
            "vault_inventory_policy_conflict",
            "Politica transitoria de inventario recusada."
          );
        }

        await transaction.query(
          [
            `CREATE POLICY ${CREDENTIAL_INVENTORY_POLICY}`,
            "  ON ia4tube_social.social_encrypted_credentials",
            "  AS PERMISSIVE",
            "  FOR SELECT",
            `  TO ${SOCIAL_OWNER_ROLE}`,
            "  USING (TRUE)"
          ].join("\n")
        );
        const result = await operation(transaction);
        await transaction.query(
          [
            `DROP POLICY ${CREDENTIAL_INVENTORY_POLICY}`,
            "  ON ia4tube_social.social_encrypted_credentials"
          ].join("\n")
        );
        return result;
      })
    );
  }

  async function listCredentialInventoryPage(input = {}) {
    const keyVersion = requireOperationalKeyVersion(
      input.targetKeyVersion
    );
    const limit = requireInventoryPageSize(input.limit);
    const cursor = requireInventoryCursor(input.cursor);
    return withCredentialInventoryPolicy(async (transaction) => {
      const result = await transaction.query(
        [
          "SELECT company_id::text, id::text AS credential_id,",
          "  key_version = $3 AS is_target_key",
          "FROM ia4tube_social.social_encrypted_credentials",
          "WHERE (",
          "  ($1::uuid IS NULL AND $2::uuid IS NULL)",
          "  OR (company_id, id) > ($1::uuid, $2::uuid)",
          ")",
          "ORDER BY company_id, id",
          "LIMIT $4"
        ].join("\n"),
        [
          cursor?.companyId || null,
          cursor?.credentialId || null,
          keyVersion,
          limit
        ]
      );
      if (
        !Array.isArray(result.rows) ||
        result.rows.length > limit
      ) {
        postgresFail(
          "vault_inventory_result_invalid",
          "Resultado do inventario recusado."
        );
      }
      const entries = result.rows.map((row) => {
        if (typeof row?.is_target_key !== "boolean") {
          postgresFail(
            "vault_inventory_result_invalid",
            "Resultado do inventario recusado."
          );
        }
        return Object.freeze({
          companyId: requireUuid(row.company_id, "company_id"),
          credentialId: requireUuid(
            row.credential_id,
            "credential_id"
          ),
          isTargetKey: row.is_target_key
        });
      });
      for (let index = 1; index < entries.length; index += 1) {
        if (
          compareInventoryEntries(entries[index - 1], entries[index]) >= 0
        ) {
          postgresFail(
            "vault_inventory_order_invalid",
            "Ordenacao do inventario recusada."
          );
        }
      }
      if (
        cursor &&
        entries.length > 0 &&
        compareInventoryEntries(cursor, entries[0]) >= 0
      ) {
        postgresFail(
          "vault_inventory_cursor_not_advanced",
          "Cursor do inventario nao avancou."
        );
      }
      const last = entries.at(-1);
      return Object.freeze({
        entries: Object.freeze(entries),
        nextCursor: last
          ? Object.freeze({
              companyId: last.companyId,
              credentialId: last.credentialId
            })
          : null,
        complete: entries.length < limit
      });
    });
  }

  async function retire({ keyVersion } = {}) {
    const version = requireOperationalKeyVersion(keyVersion);
    const digest = versionDigest(version);
    try {
      return await withRotationBarrier((client) =>
        ownerTransaction(client, async (transaction) => {
          const state = await readRegistryState(transaction);
          if (state.active?.digest === digest) {
            postgresFail(
              "vault_active_key_retirement_refused",
              "Retirada da chave ativa recusada."
            );
          }
          if (state.retiredDigests.has(digest)) {
            return Object.freeze({
              keyVersion: version,
              retired: false
            });
          }
          const result = await transaction.query(
            [
              `DELETE FROM ${VAULT_KEY_REGISTRY}`,
              "WHERE key_version = $1",
              "RETURNING key_version"
            ].join("\n"),
            [version]
          );
          if (result.rowCount !== 1) {
            postgresFail(
              "vault_key_version_not_registered",
              "Versao de chave nao registrada."
            );
          }
          await insertMarker(transaction, retirementMarker(digest));
          return Object.freeze({
            keyVersion: version,
            retired: true
          });
        })
      );
    } catch (error) {
      if (
        ["23001", "23503"].includes(error?.code) &&
        error?.constraint === CREDENTIAL_KEY_FOREIGN_KEY
      ) {
        postgresFail(
          "vault_key_version_in_use",
          "Versao de chave ainda referenciada."
        );
      }
      throw error;
    }
  }

  return Object.freeze({
    currentAuthority,
    listCredentialInventoryPage,
    register,
    retire,
    withActiveVersion
  });
}

module.exports = {
  ACTIVE_MARKER_PATTERN,
  CREDENTIAL_INVENTORY_POLICY,
  CREDENTIAL_KEY_FOREIGN_KEY,
  MAX_CREDENTIAL_INVENTORY_PAGE_SIZE,
  RETIREMENT_MARKER_PATTERN,
  SOCIAL_OWNER_ROLE,
  VAULT_AUTHORITY_MARKER_PREFIX,
  VAULT_KEY_REGISTRY,
  VAULT_ROTATION_LOCK_ID,
  VERSION_DIGEST_BYTES,
  activeMarker,
  createVaultKeyRegistryAdmin,
  compareInventoryEntries,
  parseRegistryRows,
  requireInventoryCursor,
  requireInventoryPageSize,
  requireOperationalKeyVersion,
  retirementMarker,
  versionDigest
};
