"use strict";

const crypto = require("node:crypto");
const { postgresFail } = require("./errors");
const OFFICIAL_OWNER_MIGRATION = "0008_social_official_owner_provisioning";
const OFFICIAL_OWNER_PROFILE = "social-schema-0008";
const OFFICIAL_OWNER_SQL_SHA256 = "65a24b7e2171320623dba1d2d5d5e63b5679545ae1d0ca3a706765608a5b5dc6";
const OFFICIAL_OWNER_BODY_SHA256 = "84d5b8698c4b3f4f194b9721b5779615e34fcf9c9791dad0a559799b73734051";
const OFFICIAL_OWNER_ARGUMENTS = "requested_company_id uuid, requested_user_id uuid, requested_identity_derivation_version text";
const OFFICIAL_OWNER_RESULT = "TABLE(company_id uuid, user_id uuid, identity_derivation_version text, role text, auth_version bigint, created boolean)";
const OFFICIAL_OWNER_ROUTINE_KEY = `ensure_official_owner|${OFFICIAL_OWNER_ARGUMENTS}`;

function officialOwnerBodyMatches(source) {
  return typeof source === "string" &&
    crypto.createHash("sha256").update(source, "utf8").digest("hex") === OFFICIAL_OWNER_BODY_SHA256;
}
function officialOwnerRoutineMatches(row, ownerRole = "ia4tube_social_owner") {
  return row?.proname === "ensure_official_owner" && row.identity_arguments === OFFICIAL_OWNER_ARGUMENTS &&
    row.function_result === OFFICIAL_OWNER_RESULT && row.owner_name === ownerRole &&
    row.prosecdef === true && row.provolatile === "v" && row.prokind === "f" &&
    row.language === "plpgsql" && row.proparallel === "u" && row.proleakproof === false &&
    row.proisstrict === false && row.proretset === true && Number(row.pronargdefaults) === 0 &&
    JSON.stringify(row.proconfig) === JSON.stringify(["search_path=pg_catalog"]) && officialOwnerBodyMatches(row.prosrc);
}
async function verifyOfficialOwnerSchema(client, { runtimeRole = "ia4tube_social_runtime", ownerRole = "ia4tube_social_owner" } = {}) {
  const routines = await client.query(`SELECT p.proname,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
    pg_catalog.pg_get_function_result(p.oid) AS function_result,
    owner.rolname AS owner_name, l.lanname AS language,
    p.prosecdef, p.provolatile, p.prokind, p.proconfig, p.prosrc,
    p.proparallel, p.proleakproof, p.proisstrict, p.proretset, p.pronargdefaults,
    pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS runtime_execute
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'ia4tube_social' AND p.proname = 'ensure_official_owner'`, [runtimeRole]);
  const acl = await client.query(`SELECT COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
    a.privilege_type, a.is_grantable, grantor.rolname AS grantor_name
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid = a.grantor
    WHERE n.nspname = 'ia4tube_social' AND p.proname = 'ensure_official_owner' AND a.grantee <> p.proowner`);
  const tables = await client.query(`SELECT r.relname, owner.rolname AS owner_name,
    r.relrowsecurity, r.relforcerowsecurity,
    pg_catalog.has_table_privilege($1, r.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
    pg_catalog.has_any_column_privilege($1, r.oid, 'INSERT,UPDATE,REFERENCES') AS runtime_write
    FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    JOIN pg_catalog.pg_roles owner ON owner.oid = r.relowner
    WHERE n.nspname = 'ia4tube_social' AND r.relname IN ('companies','users','company_memberships')
    ORDER BY r.relname`, [runtimeRole]);
  const grant = acl.rows?.[0];
  const expectedTables = ["companies", "company_memberships", "users"];
  if (routines.rows?.length !== 1 || !officialOwnerRoutineMatches(routines.rows[0], ownerRole) ||
      routines.rows[0].runtime_execute !== true || acl.rows?.length !== 1 ||
      grant.grantee !== runtimeRole || grant.privilege_type !== "EXECUTE" || grant.is_grantable !== false || grant.grantor_name !== ownerRole ||
      tables.rows?.length !== 3 || tables.rows.some((row, index) => row.relname !== expectedTables[index] ||
        row.owner_name !== ownerRole || row.relrowsecurity !== true || row.relforcerowsecurity !== true || row.runtime_write !== false)) {
    postgresFail("postgres_official_owner_schema_mismatch", "Contrato de provisionamento oficial divergente.");
  }
  return Object.freeze({ profile: OFFICIAL_OWNER_PROFILE, officialOwnerProvisioning: true,
    routineBodySha256: OFFICIAL_OWNER_BODY_SHA256, directRuntimeIdentityWrite: false });
}

module.exports = { OFFICIAL_OWNER_MIGRATION, OFFICIAL_OWNER_PROFILE, OFFICIAL_OWNER_SQL_SHA256,
  OFFICIAL_OWNER_BODY_SHA256, OFFICIAL_OWNER_ARGUMENTS, OFFICIAL_OWNER_RESULT, OFFICIAL_OWNER_ROUTINE_KEY,
  officialOwnerBodyMatches, officialOwnerRoutineMatches, verifyOfficialOwnerSchema };
