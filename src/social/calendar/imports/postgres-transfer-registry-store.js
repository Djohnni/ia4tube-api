"use strict";
const { withTransaction } = require("../../../persistence/postgres/pool");
const { validateTransferRegistryState, TransferRegistryError } = require("./transfer-registry");
const ROLE = "ia4tube_media_transfer_runtime";
function fail(code) { throw new TransferRegistryError(code); }

function createPostgresTransferRegistryStore({ pool, role = ROLE } = {}) {
  if (!pool || typeof pool.connect !== "function" || role !== ROLE) fail("store_configuration_invalid");
  async function transaction(operation) {
    try { return await withTransaction(pool, operation, { role }); }
    catch (error) { if (error instanceof TransferRegistryError) throw error; fail("storage_unavailable"); }
  }
  async function verifyClient(client) {
    const result = await client.query(`SELECT current_user AS principal,
      pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
      (SELECT pg_get_expr(p.polqual,p.polrelid) FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS scope_using,
      (SELECT pg_get_expr(p.polwithcheck,p.polrelid) FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS scope_check,
      (SELECT p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=$1)]::oid[] AND p.polcmd='*'
        FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS policy_role_exact,
      EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN (current_user,session_user)
        AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)) AS unsafe_principal,
      EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname NOT IN (current_user,session_user,$1)
        AND (pg_has_role(current_user,r.oid,'MEMBER') OR pg_has_role(session_user,r.oid,'MEMBER'))) AS unexpected_membership,
      pg_get_userbyid(c.relowner) IN (current_user,session_user) AS session_owns_table,
      EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database()
        AND pg_get_userbyid(d.datdba) IN (current_user,session_user)) AS session_owns_database,
      EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS custom_trigger,
      EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee=0) AS public_table_access,
      EXISTS(SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee=0) AS public_schema_access,
      EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee NOT IN
        (c.relowner,(SELECT oid FROM pg_roles WHERE rolname=$1)) OR
        (a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND a.is_grantable)) AS unexpected_table_access,
      EXISTS(SELECT 1 FROM pg_attribute column_info CROSS JOIN LATERAL aclexplode(column_info.attacl) a
        WHERE column_info.attrelid=c.oid AND (a.grantee NOT IN
          (c.relowner,(SELECT oid FROM pg_roles WHERE rolname=$1)) OR
          (a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND a.is_grantable))) AS unexpected_column_access,
      has_schema_privilege(current_user,n.oid,'CREATE') OR has_schema_privilege(session_user,n.oid,'CREATE') AS creatable,
      has_table_privilege($1,c.oid,'SELECT') AS readable,
      has_column_privilege($1,c.oid,'document','UPDATE') AS document_mutable,
      has_column_privilege($1,c.oid,'revision','UPDATE') AS revision_mutable,
      has_column_privilege($1,c.oid,'updated_at','UPDATE') AS timestamp_mutable,
      has_column_privilege($1,c.oid,'singleton','UPDATE') AS key_mutable,
      has_table_privilege($1,c.oid,'INSERT') AS insertable,
      has_table_privilege($1,c.oid,'DELETE') AS deletable,
      has_table_privilege($1,c.oid,'TRUNCATE') AS truncatable,
      EXISTS(SELECT 1 FROM pg_roles tenant WHERE tenant.rolname IN ('ia4tube_social_runtime','ia4tube_media_capacity_runtime')
        AND (pg_has_role(tenant.oid,$1,'MEMBER') OR has_table_privilege(tenant.oid,c.oid,'SELECT') OR
          has_table_privilege(tenant.oid,c.oid,'INSERT') OR has_table_privilege(tenant.oid,c.oid,'UPDATE') OR
          has_table_privilege(tenant.oid,c.oid,'DELETE') OR has_any_column_privilege(tenant.oid,c.oid,'SELECT') OR
          has_any_column_privilege(tenant.oid,c.oid,'UPDATE'))) AS foreign_registry_access,
      EXISTS(SELECT 1 FROM pg_class other JOIN pg_namespace other_ns ON other_ns.oid=other.relnamespace
        WHERE other_ns.nspname IN ('ia4tube_social','ia4tube_social_admin','ia4tube_calendar') AND other.oid<>c.oid
        AND other.relkind IN ('r','p','v','m','f')
        AND (has_table_privilege(current_user,other.oid,'SELECT') OR has_table_privilege(session_user,other.oid,'SELECT') OR
          has_table_privilege(current_user,other.oid,'INSERT') OR has_table_privilege(session_user,other.oid,'INSERT') OR
          has_table_privilege(current_user,other.oid,'UPDATE') OR has_table_privilege(session_user,other.oid,'UPDATE') OR
          has_table_privilege(current_user,other.oid,'DELETE') OR has_table_privilege(session_user,other.oid,'DELETE') OR
          has_table_privilege(current_user,other.oid,'TRUNCATE') OR has_table_privilege(session_user,other.oid,'TRUNCATE') OR
          has_any_column_privilege(current_user,other.oid,'SELECT') OR has_any_column_privilege(session_user,other.oid,'SELECT') OR
          has_any_column_privilege(current_user,other.oid,'INSERT') OR has_any_column_privilege(session_user,other.oid,'INSERT') OR
          has_any_column_privilege(current_user,other.oid,'UPDATE') OR has_any_column_privilege(session_user,other.oid,'UPDATE'))) AS foreign_data_access
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='ia4tube_calendar' AND c.relname='transfer_authorization_registry'`, [ROLE]);
    const row = result.rows?.[0], normalize = value => String(value || "").replace(/[\s()]/g, "");
    const required = ["rls", "forced", "policy_role_exact", "readable", "document_mutable", "revision_mutable", "timestamp_mutable"];
    const forbidden = ["unsafe_principal", "unexpected_membership", "session_owns_table", "session_owns_database", "custom_trigger",
      "public_table_access", "public_schema_access", "unexpected_table_access", "unexpected_column_access", "creatable", "key_mutable", "insertable", "deletable",
      "truncatable", "foreign_registry_access", "foreign_data_access"];
    if (result.rows?.length !== 1 || row.principal !== ROLE || row.owner !== "ia4tube_social_owner" || Number(row.policies) !== 1 ||
        normalize(row.scope_using) !== "singleton=1" || normalize(row.scope_check) !== "singleton=1" ||
        required.some(key => row[key] !== true) || forbidden.some(key => row[key] !== false)) fail("schema_not_ready");
    return true;
  }
  return Object.freeze({
    capabilities: Object.freeze({ persistence: "durable", atomicGrantUpdates: true, boundedRegistryLedger: true }),
    async verify() { return transaction(verifyClient); },
    async update(operation) {
      if (typeof operation !== "function" || operation.constructor?.name === "AsyncFunction") fail("async_transaction_forbidden");
      return transaction(async client => {
        await verifyClient(client);
        const found = await client.query("SELECT document FROM ia4tube_calendar.transfer_authorization_registry WHERE singleton=1 FOR UPDATE");
        if (found.rows?.length !== 1) fail("schema_not_ready");
        const state = validateTransferRegistryState(found.rows[0].document), before = JSON.stringify(state);
        const result = operation(state);
        if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); fail("async_transaction_forbidden"); }
        validateTransferRegistryState(state);
        const output = structuredClone(result), after = JSON.stringify(state);
        if (after !== before) {
          const updated = await client.query(`UPDATE ia4tube_calendar.transfer_authorization_registry
            SET document=$1::jsonb,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE singleton=1`, [after]);
          if (updated.rowCount !== 1) fail("storage_unavailable");
        }
        return output;
      }); // No provider/network callback and no retry after an uncertain COMMIT.
    }
  });
}
module.exports = { createPostgresTransferRegistryStore };
