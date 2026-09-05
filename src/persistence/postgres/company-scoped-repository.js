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

  async function findActiveOwner({ companyId, userId } = {}) {
    const scopedCompanyId = requireUuid(companyId, "company_id");
    const scopedUserId = requireUuid(userId, "user_id");
    return scoped(scopedCompanyId, async (client) => {
      // One SELECT snapshot for all three records, using existing column-level
      // SELECT grants only. This repository never provisions or repairs rows.
      const result = await client.query([
        "SELECT company.id AS company_id, app_user.id AS user_id,",
        " company.identity_derivation_version, app_user.auth_version, membership.role",
        "FROM ia4tube_social.companies company",
        "JOIN ia4tube_social.users app_user ON app_user.company_id=company.id AND app_user.id=$2",
        "JOIN ia4tube_social.company_memberships membership",
        " ON membership.company_id=company.id AND membership.user_id=app_user.id",
        "WHERE company.id=$1 AND company.identity_derivation_version=$3",
        " AND company.status='active' AND app_user.status='active'",
        " AND membership.status='active' AND membership.role='owner'"
      ].join("\n"), [scopedCompanyId, scopedUserId, identityDerivationVersion]);
      const row = result.rows?.[0];
      if (!row) return null;
      if (result.rows.length !== 1 || row.company_id !== scopedCompanyId || row.user_id !== scopedUserId ||
          row.identity_derivation_version !== identityDerivationVersion || row.role !== "owner" ||
          !Number.isSafeInteger(Number(row.auth_version)) || Number(row.auth_version) < 1) {
        postgresFail("social_tenant_readiness_unavailable", "Vinculo da empresa indisponivel.");
      }
      return Object.freeze({ companyId: scopedCompanyId, userId: scopedUserId,
        identityDerivationVersion, role: "owner", authVersion: Number(row.auth_version) });
    });
  }

  return Object.freeze({
    findActiveOwner,
    findCompanyById,
    findMembership
  });
}

module.exports = {
  createCompanyScopedRepository
};
