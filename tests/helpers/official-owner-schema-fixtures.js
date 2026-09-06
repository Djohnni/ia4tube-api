"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { OFFICIAL_OWNER_ARGUMENTS, OFFICIAL_OWNER_RESULT } = require("../../src/persistence/postgres/official-owner-schema");
function officialOwnerRoutine() {
  const sql = fs.readFileSync(path.join(__dirname, "../../db/migrations/0008_social_official_owner_provisioning.up.sql"), "utf8");
  return { proname: "ensure_official_owner", identity_arguments: OFFICIAL_OWNER_ARGUMENTS,
    function_result: OFFICIAL_OWNER_RESULT, owner_name: "ia4tube_social_owner", language: "plpgsql",
    prosecdef: true, provolatile: "v", prokind: "f", proconfig: ["search_path=pg_catalog"],
    prosrc: sql.split("$official_owner$")[1], proparallel: "u", proleakproof: false,
    proisstrict: false, proretset: true, pronargdefaults: 0, runtime_execute: true };
}
function officialOwnerAcl() {
  return { grantee: "ia4tube_social_runtime", privilege_type: "EXECUTE", is_grantable: false, grantor_name: "ia4tube_social_owner" };
}
function officialOwnerTables() {
  return ["companies", "company_memberships", "users"].map(relname => ({ relname,
    owner_name: "ia4tube_social_owner", relrowsecurity: true, relforcerowsecurity: true, runtime_write: false }));
}
function officialOwnerQueryFixture(sql) {
  if (sql.includes("AS runtime_execute")) return { rows: [officialOwnerRoutine()] };
  if (sql.includes("p.proname = 'ensure_official_owner' AND a.grantee")) return { rows: [officialOwnerAcl()] };
  if (sql.includes("AS runtime_write")) return { rows: officialOwnerTables() };
  return null;
}
module.exports = { officialOwnerRoutine, officialOwnerAcl, officialOwnerTables, officialOwnerQueryFixture };
