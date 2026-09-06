"use strict";

const assert = require("node:assert/strict");
const { ENSURE_OFFICIAL_OWNER_SQL } = require("../../src/persistence/postgres/production-tenant-repository");

// A strict repository/HTTP protocol double, NOT proof that the SQL function,
// RLS, ACLs or database concurrency are correct. Those require physical PG18.
function createTenantMemoryPool() {
  const tenants = new Map(), statements = [];
  let chain = Promise.resolve(), failure = null, responseMutation = null;
  return {
    tenants, statements,
    setFailure(value) { failure = value; },
    mutateResponse(value) { responseMutation = value; },
    async connect() {
      let releaseTurn, snapshot, company, user;
      return { release() {}, async query(sql, parameters = []) {
        statements.push({ sql, parameters: [...parameters] });
        if (sql === "BEGIN") {
          const previous = chain;
          chain = new Promise(resolve => { releaseTurn = resolve; });
          await previous;
          snapshot = structuredClone(tenants);
          return { rows: [] };
        }
        if (sql === "ROLLBACK" || sql === "COMMIT") {
          if (sql === "ROLLBACK") { tenants.clear(); for (const [key, value] of snapshot) tenants.set(key, value); }
          releaseTurn(); return { rows: [] };
        }
        if (sql === 'SET LOCAL ROLE "ia4tube_social_runtime"') return { rows: [] };
        if (sql === "SELECT set_config('ia4tube.company_id', $1, true)") { company = parameters[0]; return { rows: [] }; }
        if (sql === "SELECT pg_catalog.set_config('ia4tube.user_id', $1, true)") { user = parameters[0]; return { rows: [] }; }
        if (["SET LOCAL statement_timeout = '1500ms'", "SET LOCAL lock_timeout = '1000ms'"].includes(sql)) return { rows: [] };
        if (sql.startsWith("SELECT company.id AS company_id")) {
          if (failure) throw failure;
          assert.equal(company, parameters[0]);
          const row = tenants.get(company);
          return { rows: row && row.user_id === parameters[1] ? [structuredClone(row)] : [] };
        }
        assert.equal(sql, ENSURE_OFFICIAL_OWNER_SQL, "unexpected SQL in tenant protocol double");
        assert.equal(company, parameters[0]); assert.equal(user, parameters[1]);
        if (failure) throw failure;
        const existing = tenants.get(company);
        if (existing && (existing.user_id !== user || existing.identity_derivation_version !== parameters[2])) {
          throw Object.assign(new Error("synthetic conflict detail"), { code: "PTB01" });
        }
        const row = existing || { company_id: company, user_id: user,
          identity_derivation_version: parameters[2], role: "owner", auth_version: "1" };
        tenants.set(company, row);
        const result = { ...row, created: !existing };
        return { rows: [responseMutation ? responseMutation(result) : result] };
      } };
    }
  };
}

module.exports = { createTenantMemoryPool };
