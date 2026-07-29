"use strict";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_LABEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const SET_COMPANY_SCOPE_SQL =
  "SELECT set_config('ia4tube.company_id', $1, true)";

class SocialPersistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SocialPersistenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SocialPersistenceError(code, message);
}

function requireDatabaseUrl(databaseUrl) {
  if (
    typeof databaseUrl !== "string" ||
    databaseUrl.length === 0 ||
    databaseUrl !== databaseUrl.trim()
  ) {
    fail(
      "database_url_missing",
      "A persistencia social exige DATABASE_URL explicita."
    );
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail(
      "database_url_invalid",
      "A configuracao do banco social foi recusada."
    );
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.pathname ||
    parsed.pathname === "/"
  ) {
    fail(
      "database_url_invalid",
      "A configuracao do banco social foi recusada."
    );
  }

  return databaseUrl;
}

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function") {
    fail(
      "postgres_pool_required",
      "O pool PostgreSQL deve ser injetado explicitamente."
    );
  }
  return pool;
}

function requireUuid(value, field) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !UUID_PATTERN.test(value) ||
    value.toLowerCase() === "00000000-0000-0000-0000-000000000000"
  ) {
    fail(`${field}_required`, `${field} valido e obrigatorio.`);
  }
  return value.toLowerCase();
}

function requireLabel(value, field) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !SAFE_LABEL_PATTERN.test(value)
  ) {
    fail(`${field}_invalid`, `${field} foi recusado.`);
  }
  return value;
}

function requireSourceId(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 500
  ) {
    fail("source_entity_id_invalid", "Identificador legado recusado.");
  }
  return value;
}

function requireSha256(value) {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !SHA256_PATTERN.test(value)
  ) {
    fail("source_sha256_invalid", "Fingerprint legado recusado.");
  }
  return value;
}

function requireQueryClient(client) {
  if (
    !client ||
    typeof client.query !== "function" ||
    typeof client.release !== "function"
  ) {
    fail(
      "postgres_client_invalid",
      "O pool PostgreSQL retornou um cliente invalido."
    );
  }
  return client;
}

function freezeRows(result) {
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function createCompanyScopedRepository(options = {}) {
  const databaseUrl = requireDatabaseUrl(options.databaseUrl);
  const pool = requirePool(options.pool);

  async function withCompanyTransaction(companyId, operation) {
    const scopedCompanyId = requireUuid(companyId, "company_id");
    if (typeof operation !== "function") {
      fail(
        "company_transaction_operation_required",
        "A operacao transacional e obrigatoria."
      );
    }

    const client = requireQueryClient(await pool.connect());
    let transactionStarted = false;
    let clientDiscarded = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(SET_COMPANY_SCOPE_SQL, [scopedCompanyId]);

      const transaction = Object.freeze({
        companyId: scopedCompanyId,
        query(text, values = []) {
          if (
            typeof text !== "string" ||
            text.trim().length === 0 ||
            !Array.isArray(values)
          ) {
            fail("postgres_query_invalid", "Consulta PostgreSQL recusada.");
          }
          return client.query(text, values);
        }
      });

      const value = await operation(transaction);
      await client.query("COMMIT");
      transactionStarted = false;
      return value;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackFailure) {
          client.release(rollbackFailure);
          clientDiscarded = true;
          const rollbackError = new SocialPersistenceError(
            "postgres_rollback_failed",
            "A transacao falhou e o rollback nao foi confirmado."
          );
          rollbackError.cause = error;
          throw rollbackError;
        }
      }
      throw error;
    } finally {
      if (!clientDiscarded) client.release();
    }
  }

  async function findCompanyById(companyId) {
    const scopedCompanyId = requireUuid(companyId, "company_id");
    return withCompanyTransaction(scopedCompanyId, async (transaction) => {
      const result = await transaction.query(
        [
          "SELECT id, name, status, created_at, updated_at",
          "FROM companies",
          "WHERE id = $1 AND status = 'active'"
        ].join("\n"),
        [scopedCompanyId]
      );
      const rows = freezeRows(result);
      return rows[0] || null;
    });
  }

  async function findMembership({ companyId, userId } = {}) {
    const scopedCompanyId = requireUuid(companyId, "company_id");
    const scopedUserId = requireUuid(userId, "user_id");
    return withCompanyTransaction(scopedCompanyId, async (transaction) => {
      const result = await transaction.query(
        [
          "SELECT company_id, user_id, role, status, created_at, updated_at",
          "FROM company_memberships",
          "WHERE company_id = $1 AND user_id = $2 AND status = 'active'"
        ].join("\n"),
        [scopedCompanyId, scopedUserId]
      );
      const rows = freezeRows(result);
      return rows[0] || null;
    });
  }

  async function recordLegacyMapping({
    id,
    migrationVersion,
    companyId,
    sourceSystem,
    sourceEntityType,
    sourceEntityId,
    sourceSha256,
    targetEntityType,
    targetEntityId
  } = {}) {
    const mappingId = requireUuid(id, "mapping_id");
    const scopedCompanyId = requireUuid(companyId, "company_id");
    const targetId = requireUuid(targetEntityId, "target_entity_id");
    const migration = requireLabel(migrationVersion, "migration_version");
    const system = requireLabel(sourceSystem, "source_system");
    const sourceType = requireLabel(
      sourceEntityType,
      "source_entity_type"
    );
    const targetType = requireLabel(
      targetEntityType,
      "target_entity_type"
    );
    const legacyId = requireSourceId(sourceEntityId);
    const fingerprint = requireSha256(sourceSha256);

    return withCompanyTransaction(scopedCompanyId, async (transaction) => {
      const insertResult = await transaction.query(
        [
          "INSERT INTO legacy_entity_mappings (",
          "  id, migration_version, company_id, source_system,",
          "  source_entity_type, source_entity_id, source_sha256,",
          "  target_entity_type, target_entity_id",
          ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          "ON CONFLICT (",
          "  migration_version, company_id, source_system,",
          "  source_entity_type, source_entity_id",
          ") DO NOTHING",
          [
            "RETURNING id, company_id, source_sha256,",
            "  target_entity_type, target_entity_id"
          ].join("\n")
        ].join("\n"),
        [
          mappingId,
          migration,
          scopedCompanyId,
          system,
          sourceType,
          legacyId,
          fingerprint,
          targetType,
          targetId
        ]
      );
      const insertedRows = freezeRows(insertResult);
      if (insertedRows[0]) return insertedRows[0];

      const existingResult = await transaction.query(
        [
          "SELECT id, company_id, source_sha256,",
          "  target_entity_type, target_entity_id",
          "FROM legacy_entity_mappings",
          "WHERE migration_version = $1",
          "  AND company_id = $2",
          "  AND source_system = $3",
          "  AND source_entity_type = $4",
          "  AND source_entity_id = $5"
        ].join("\n"),
        [migration, scopedCompanyId, system, sourceType, legacyId]
      );
      const existingRows = freezeRows(existingResult);
      const existing = existingRows[0];
      if (
        !existing ||
        existing.company_id !== scopedCompanyId ||
        existing.source_sha256 !== fingerprint ||
        existing.target_entity_type !== targetType ||
        existing.target_entity_id !== targetId
      ) {
        fail(
          "legacy_mapping_conflict",
          "O mapeamento legado existente diverge da repeticao solicitada."
        );
      }
      return existing;
    });
  }

  return Object.freeze({
    databaseUrlConfigured: Boolean(databaseUrl),
    findCompanyById,
    findMembership,
    recordLegacyMapping,
    withCompanyTransaction
  });
}

module.exports = {
  SET_COMPANY_SCOPE_SQL,
  SocialPersistenceError,
  createCompanyScopedRepository
};
