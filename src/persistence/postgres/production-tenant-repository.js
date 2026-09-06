"use strict";

const { withTransaction } = require("./pool");
const { requireKeyVersion, requireSafeLabel } = require("./validation");
const { officialOwnerBinding, ProductionTenantBindingError } = require("../../social/production-tenant-binding");

// This prepared adapter requires the separately reviewed 0008 function and
// runtime catalog profile. It is intentionally not mounted by this module.
const ENSURE_OFFICIAL_OWNER_SQL = [
  "SELECT company_id, user_id, identity_derivation_version, role, auth_version, created",
  "FROM ia4tube_social.ensure_official_owner($1::uuid, $2::uuid, $3::text)"
].join("\n");
const CONFLICT_SQLSTATE = "PTB01";

function createProductionTenantRepository(options = {}) {
  const pool = options.pool;
  if (!pool || typeof pool.connect !== "function") throw new TypeError("Pool social obrigatorio.");
  const role = requireSafeLabel(options.runtimeRole || "ia4tube_social_runtime", "runtime_role");
  const version = requireKeyVersion(options.identityDerivationVersion);

  async function ensureOfficialOwner(principal) {
    const binding = officialOwnerBinding(principal, version);
    try {
      return await withTransaction(pool, async client => {
        await client.query("SELECT pg_catalog.set_config('ia4tube.user_id', $1, true)", [binding.userId]);
        await client.query("SET LOCAL statement_timeout = '1500ms'");
        await client.query("SET LOCAL lock_timeout = '1000ms'");
        const result = await client.query(ENSURE_OFFICIAL_OWNER_SQL,
          [binding.companyId, binding.userId, binding.derivationVersion]);
        const row = result.rows?.[0];
        if (result.rows?.length !== 1 || row.company_id !== binding.companyId ||
            row.user_id !== binding.userId || row.identity_derivation_version !== binding.derivationVersion ||
            row.role !== "owner" || typeof row.created !== "boolean" ||
            !/^[1-9][0-9]*$/.test(String(row.auth_version)) ||
            !Number.isSafeInteger(Number(row.auth_version))) {
          throw new ProductionTenantBindingError("social_tenant_provisioning_unavailable");
        }
        return Object.freeze({ companyId: binding.companyId, userId: binding.userId,
          identityDerivationVersion: binding.derivationVersion, role: "owner",
          authVersion: Number(row.auth_version), created: row.created });
      }, { companyId: binding.companyId, role });
    } catch (error) {
      // Driver messages/detail/cause can contain SQL data or connection details.
      // Only the function's reserved SQLSTATE is translated; never forward text.
      throw new ProductionTenantBindingError(error?.code === CONFLICT_SQLSTATE
        ? "social_tenant_binding_conflict" : "social_tenant_provisioning_unavailable");
    }
  }
  return Object.freeze({ ensureOfficialOwner });
}

module.exports = { CONFLICT_SQLSTATE, ENSURE_OFFICIAL_OWNER_SQL, createProductionTenantRepository };
