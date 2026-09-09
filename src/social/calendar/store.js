"use strict";
const { withTransaction } = require("../../persistence/postgres/pool");
const { freshState, UUID, fail, MAX_ITEMS } = require("./model");
function validate(state) {
  if (!state || state.schema !== 1 || !state.preferences || typeof state.preferences.enabled !== "boolean" ||
      !state.jobs || Array.isArray(state.jobs) || Object.keys(state.jobs).length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(state), "utf8") > 8 * 1024 * 1024) fail("calendar_state_invalid", 503);
  return state;
}
function createCalendarStore({ pool, role }) {
  return Object.freeze({
    async exists(companyId) {
      if (!UUID.test(companyId)) fail("calendar_owner_invalid", 403);
      return withTransaction(pool, async client => {
        const rows = await client.query("SELECT 1 FROM ia4tube_calendar.owner_state WHERE company_id=$1", [companyId]);
        return rows.rowCount === 1;
      }, { companyId, role });
    },
    async verify() {
      const result = await pool.query(`SELECT c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
        pg_get_userbyid(c.relowner) AS owner,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
        (SELECT pg_get_expr(p.polqual,p.polrelid) FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS scope_using,
        (SELECT pg_get_expr(p.polwithcheck,p.polrelid) FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS scope_check,
        EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS custom_trigger,
        EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee=0) AS public_table_access,
        EXISTS(SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee=0) AS public_schema_access,
        has_column_privilege($1,c.oid,'company_id','UPDATE') AS owner_mutable,
        has_table_privilege($1,c.oid,'SELECT') AS readable,
        has_table_privilege($1,c.oid,'TRUNCATE') AS truncatable,
        has_table_privilege($1,c.oid,'DELETE') AS deletable,
        has_schema_privilege($1,n.oid,'CREATE') AS creatable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='ia4tube_calendar' AND c.relname='owner_state'`, [role]);
      const row = result.rows?.[0];
      const normalize = value => String(value || "").replace(/[\s()]/g, "").replace(/::text/g, "").toLowerCase();
      const scope = normalize("company_id = nullif(current_setting('ia4tube.company_id', true), '')::uuid");
      if (result.rows?.length !== 1 || !row.rls || !row.forced || row.owner !== "ia4tube_social_owner" ||
          Number(row.policies) !== 1 || !row.readable || row.truncatable || row.deletable || row.creatable ||
          row.custom_trigger || row.public_table_access || row.public_schema_access || row.owner_mutable ||
          normalize(row.scope_using) !== scope || normalize(row.scope_check) !== scope) fail("calendar_schema_not_ready", 503);
    },
    async update(companyId, operation) {
      if (!UUID.test(companyId)) fail("calendar_owner_invalid", 403);
      return withTransaction(pool, async client => {
        // Includes the absent-row case; both UI mutations and the worker use this lock.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`calendar:${companyId}`]);
        const rows = await client.query("SELECT document FROM ia4tube_calendar.owner_state WHERE company_id=$1 FOR UPDATE", [companyId]);
        const state = validate(rows.rows[0]?.document || freshState());
        const before = rows.rows[0] ? JSON.stringify(state) : null;
        const result = await operation(state);
        validate(state);
        if (JSON.stringify(state) !== before) await client.query(`INSERT INTO ia4tube_calendar.owner_state(company_id,document) VALUES($1,$2::jsonb)
          ON CONFLICT(company_id) DO UPDATE SET document=EXCLUDED.document,
          revision=owner_state.revision+1,updated_at=CURRENT_TIMESTAMP`, [companyId, JSON.stringify(state)]);
        return structuredClone(result);
      }, { companyId, role });
    }
  });
}
module.exports = { createCalendarStore, validate };
