"use strict";

const { postgresFail } = require("./errors");
const { withTransaction } = require("./pool");
const {
  requireKeyVersion,
  requireSafeLabel,
  requireUuid
} = require("./validation");

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createCompanyScopedRepository(options = {}) {
  const pool = options.pool;
  const role = requireSafeLabel(
    options.runtimeRole || "ia4tube_social_runtime",
    "runtime_role"
  );
  const identityDerivationVersion = requireKeyVersion(
    options.identityDerivationVersion
  );
  if (!pool || typeof pool.connect !== "function") {
    postgresFail("postgres_pool_required", "Pool PostgreSQL obrigatorio.");
  }

  function scoped(companyId, operation) {
    return withTransaction(pool, operation, {
      companyId: requireUuid(companyId, "company_id"),
      role
    });
  }

  async function findCompanyById(companyId) {
    const id = requireUuid(companyId, "company_id");
    return scoped(id, async (client) => {
      const result = await client.query(
        [
          "SELECT id, name, status, identity_derivation_version,",
          "  created_at, updated_at",
          "FROM ia4tube_social.companies",
          "WHERE id = $1 AND status = 'active'",
          "  AND identity_derivation_version = $2"
        ].join("\n"),
        [id, identityDerivationVersion]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  async function findMembership({ companyId, userId } = {}) {
    const scopedCompanyId = requireUuid(companyId, "company_id");
    const scopedUserId = requireUuid(userId, "user_id");
    return scoped(scopedCompanyId, async (client) => {
      const result = await client.query(
        [
          "SELECT membership.company_id, membership.user_id,",
          "  membership.role, membership.status,",
          "  membership.created_at, membership.updated_at",
          "FROM ia4tube_social.company_memberships membership",
          "JOIN ia4tube_social.companies company",
          "  ON company.id = membership.company_id",
          "WHERE membership.company_id = $1",
          "  AND membership.user_id = $2",
          "  AND membership.status = 'active'",
          "  AND company.status = 'active'",
          "  AND company.identity_derivation_version = $3"
        ].join("\n"),
        [scopedCompanyId, scopedUserId, identityDerivationVersion]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  return Object.freeze({
    findCompanyById,
    findMembership
  });
}

module.exports = {
  createCompanyScopedRepository
};
