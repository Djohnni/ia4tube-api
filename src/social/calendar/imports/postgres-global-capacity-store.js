"use strict";
const { withTransaction } = require("../../../persistence/postgres/pool");
const { validateGlobalCapacityState } = require("./global-capacity");
const ROLE = "ia4tube_media_capacity_runtime";
function fail(code) {
  const error = new Error(`media_capacity_${code}`); error.code = error.message; error.statusCode = 503; throw error;
}
function createPostgresGlobalCapacityStore({ pool, role = ROLE } = {}) {
  if (!pool || typeof pool.connect !== "function" || role !== ROLE) fail("store_configuration_invalid");
  async function transaction(operation) {
    try { return await withTransaction(pool, operation, { role }); }
    catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("media_capacity_")) throw error;
      fail("storage_unavailable"); // No query text, credentials or provider details escape this boundary.
    }
  }
  async function verifyClient(client) {
    const result = await client.query(`SELECT current_user AS principal,
      pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
      (SELECT pg_get_expr(p.polqual,p.polrelid) FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS scope_using,
      (SELECT pg_get_expr(p.polwithcheck,p.polrelid) FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS scope_check,
      (SELECT p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=$1)]::oid[] FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS policy_role_exact,
      EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN (current_user,session_user)
        AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb)) AS unsafe_principal,
      pg_get_userbyid(c.relowner) IN (current_user,session_user) AS session_owns_table,
      EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS custom_trigger,
      EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee=0) AS public_table_access,
      EXISTS(SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee=0) AS public_schema_access,
      has_schema_privilege(current_user,n.oid,'CREATE') OR has_schema_privilege(session_user,n.oid,'CREATE') AS creatable,
      has_table_privilege($1,c.oid,'SELECT') AS readable,
      has_column_privilege($1,c.oid,'document','UPDATE') AS document_mutable,
      has_column_privilege($1,c.oid,'singleton','UPDATE') AS key_mutable,
      has_table_privilege($1,c.oid,'INSERT') AS insertable,
      has_table_privilege($1,c.oid,'DELETE') AS deletable,
      has_table_privilege($1,c.oid,'TRUNCATE') AS truncatable,
      has_table_privilege('ia4tube_social_runtime',c.oid,'SELECT') OR
        has_table_privilege('ia4tube_social_runtime',c.oid,'INSERT') OR
        has_table_privilege('ia4tube_social_runtime',c.oid,'UPDATE') OR
        has_table_privilege('ia4tube_social_runtime',c.oid,'DELETE') OR
        has_any_column_privilege('ia4tube_social_runtime',c.oid,'UPDATE') AS tenant_access,
      pg_has_role(current_user,'ia4tube_social_runtime','MEMBER') OR pg_has_role(session_user,'ia4tube_social_runtime','MEMBER') OR
        pg_has_role(current_user,'ia4tube_social_owner','MEMBER') OR pg_has_role(session_user,'ia4tube_social_owner','MEMBER') OR
        EXISTS(SELECT 1 FROM pg_class other JOIN pg_namespace other_ns ON other_ns.oid=other.relnamespace
          WHERE other_ns.nspname IN ('ia4tube_social','ia4tube_calendar') AND other.oid<>c.oid AND other.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(current_user,other.oid,'SELECT') OR has_table_privilege(session_user,other.oid,'SELECT') OR
            has_table_privilege(current_user,other.oid,'INSERT') OR has_table_privilege(session_user,other.oid,'INSERT') OR
            has_table_privilege(current_user,other.oid,'UPDATE') OR has_table_privilege(session_user,other.oid,'UPDATE') OR
            has_table_privilege(current_user,other.oid,'DELETE') OR has_table_privilege(session_user,other.oid,'DELETE') OR
            has_any_column_privilege(current_user,other.oid,'SELECT') OR has_any_column_privilege(session_user,other.oid,'SELECT') OR
            has_any_column_privilege(current_user,other.oid,'UPDATE') OR has_any_column_privilege(session_user,other.oid,'UPDATE'))) AS tenant_data_access
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='ia4tube_calendar' AND c.relname='global_media_capacity'`, [ROLE]);
    const row = result.rows?.[0], normalize = text => String(text || "").replace(/[\s()]/g, "");
    if (result.rows?.length !== 1 || row.principal !== ROLE || row.owner !== "ia4tube_social_owner" || !row.rls || !row.forced ||
        Number(row.policies) !== 1 || !row.policy_role_exact || normalize(row.scope_using) !== "singleton=1" ||
        normalize(row.scope_check) !== "singleton=1" || !row.readable || !row.document_mutable || row.key_mutable ||
        row.unsafe_principal || row.session_owns_table || row.public_table_access || row.public_schema_access || row.custom_trigger ||
        row.creatable || row.insertable || row.deletable || row.truncatable || row.tenant_access || row.tenant_data_access) fail("schema_not_ready");
    return true;
  }
  return Object.freeze({
    capabilities: Object.freeze({ persistence: "durable", atomicGlobalUpdates: true }),
    async verify() { return transaction(verifyClient); },
    async update(operation) {
      if (typeof operation !== "function" || operation.constructor?.name === "AsyncFunction") fail("async_transaction_forbidden");
      return transaction(async client => {
        // Dedicated-role schema verification and lock belong to this same transaction.
        await verifyClient(client);
        const found = await client.query("SELECT document FROM ia4tube_calendar.global_media_capacity WHERE singleton=1 FOR UPDATE");
        if (found.rows?.length !== 1) fail("schema_not_ready");
        const state = validateGlobalCapacityState(found.rows[0].document), before = JSON.stringify(state);
        const result = operation(state);
        if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); fail("async_transaction_forbidden"); }
        validateGlobalCapacityState(state);
        const after = JSON.stringify(state);
        if (after !== before) await client.query(`UPDATE ia4tube_calendar.global_media_capacity
          SET document=$1::jsonb,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE singleton=1`, [after]);
        return structuredClone(result);
      }); // Existing helper commits before resolving, never blindly replays an uncertain commit.
    }
  });
}
module.exports = { createPostgresGlobalCapacityStore };
