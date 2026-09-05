"use strict";

const { postgresFail } = require("./errors");
const BINDING_MIGRATION = "0007_social_publication_connection_binding";
const BINDING_PROFILE = "social-schema-0007";
const BINDING_SQL_SHA256 = "4747e001e3057b12facabb74f2529272d8c9cd4e933f55322ee9e3bc82483464";
const BINDING_COLUMNS = Object.freeze(["bound_external_account_id", "expected_connection_revision"]);
const BINDING_CONSTRAINTS = Object.freeze([
  "social_publications_binding_pair",
  "social_publications_binding_revision_valid",
  "social_publications_bound_account_fk"
]);
function canonicalExpression(value) {
  return String(value || "").toLowerCase().replace(/'([0-9]+)'/g, "$1")
    .replace(/::(?:bigint|integer)\b/g, "").replace(/[\s()]+/g, "");
}
const BOUND_EXPRESSION = "bound_external_account_idisnotnullandexpected_connection_revisionisnotnull";
function bindingPoliciesMatch(rows, runtimeRole = "ia4tube_social_runtime") {
  if (!Array.isArray(rows) || rows.length !== 2) return false;
  return ["INSERT", "UPDATE"].every((command) => {
    const policy = rows.find((row) => row.policyname === `social_publications_bound_${command.toLowerCase()}`);
    return policy?.tablename === "social_publications" && policy.permissive === "RESTRICTIVE" &&
      policy.cmd === command && Array.isArray(policy.roles) && policy.roles.length === 1 &&
      policy.roles[0] === runtimeRole && canonicalExpression(policy.with_check) === BOUND_EXPRESSION &&
      (command === "INSERT" ? policy.qual === null : canonicalExpression(policy.qual) === BOUND_EXPRESSION);
  });
}
function bindingColumnsMatch(rows) {
  if (!Array.isArray(rows) || rows.length !== 2) return false;
  return BINDING_COLUMNS.every((name, index) => {
    const column = rows.find((row) => row.column_name === name);
    return column && column.data_type === (index === 0 ? "uuid" : "bigint") &&
      column.not_null === false && column.has_default === false &&
      column.generated === "" && column.identity === "";
  });
}
function bindingConstraintsMatch(rows) {
  if (!Array.isArray(rows) || rows.length !== 3) return false;
  const byName = new Map(rows.map((row) => [row.constraint_name, row]));
  if (byName.size !== 3 || rows.some((row) => !BINDING_CONSTRAINTS.includes(row.constraint_name) ||
      row.validated !== true || row.deferrable !== false || row.initially_deferred !== false)) return false;
  const pair = byName.get(BINDING_CONSTRAINTS[0]);
  const revision = byName.get(BINDING_CONSTRAINTS[1]);
  const fk = byName.get(BINDING_CONSTRAINTS[2]);
  return pair.constraint_type === "c" &&
    canonicalExpression(pair.expression) === "bound_external_account_idisnull=expected_connection_revisionisnull" &&
    revision.constraint_type === "c" && canonicalExpression(revision.expression) ===
      "expected_connection_revisionisnullorexpected_connection_revision>=1andexpected_connection_revision<=9007199254740991" &&
    fk.constraint_type === "f" && fk.foreign_schema === "ia4tube_social" &&
    fk.foreign_table === "social_external_accounts" && fk.delete_action === "r" &&
    fk.update_action === "a" && fk.match_type === "s" &&
    JSON.stringify(fk.columns) === JSON.stringify(["company_id", "connection_id", "bound_external_account_id"]) &&
    JSON.stringify(fk.foreign_columns) === JSON.stringify(["company_id", "connection_id", "id"]);
}
async function verifyPublicationBindingSchema(client, { runtimeRole = "ia4tube_social_runtime" } = {}) {
  const columns = await client.query(`SELECT a.attname AS column_name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
    a.attnotnull AS not_null, a.atthasdef AS has_default,
    a.attgenerated AS generated, a.attidentity AS identity
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class r ON r.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'ia4tube_social' AND r.relname = 'social_publications'
      AND a.attname = ANY($1::text[]) AND NOT a.attisdropped
    ORDER BY a.attname`, [BINDING_COLUMNS]);
  const constraints = await client.query(`SELECT c.conname AS constraint_name,
    c.contype AS constraint_type, c.convalidated AS validated,
    c.condeferrable AS deferrable, c.condeferred AS initially_deferred,
    pg_catalog.pg_get_expr(c.conbin, c.conrelid, true) AS expression,
    fn.nspname AS foreign_schema, fr.relname AS foreign_table,
    c.confdeltype AS delete_action, c.confupdtype AS update_action, c.confmatchtype AS match_type,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(id, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.id ORDER BY k.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(id, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.id ORDER BY k.ord) AS foreign_columns
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    LEFT JOIN pg_catalog.pg_class fr ON fr.oid = c.confrelid
    LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fr.relnamespace
    WHERE n.nspname = 'ia4tube_social' AND r.relname = 'social_publications'
      AND c.conname = ANY($1::text[]) ORDER BY c.conname`, [BINDING_CONSTRAINTS]);
  const policies = await client.query(`SELECT tablename, policyname, permissive,
    roles::text[] AS roles, cmd, qual, with_check FROM pg_catalog.pg_policies
    WHERE schemaname = 'ia4tube_social' AND tablename = 'social_publications'
      AND policyname IN ('social_publications_bound_insert', 'social_publications_bound_update')
    ORDER BY policyname`);
  const permissions = await client.query(`SELECT
    pg_catalog.has_column_privilege($1, r.oid, 'bound_external_account_id', 'SELECT') AND
    pg_catalog.has_column_privilege($1, r.oid, 'expected_connection_revision', 'SELECT') AS can_read,
    pg_catalog.has_column_privilege($1, r.oid, 'bound_external_account_id', 'INSERT') AND
    pg_catalog.has_column_privilege($1, r.oid, 'expected_connection_revision', 'INSERT') AS can_insert,
    pg_catalog.has_column_privilege($1, r.oid, 'bound_external_account_id', 'UPDATE') OR
    pg_catalog.has_column_privilege($1, r.oid, 'expected_connection_revision', 'UPDATE') AS can_update
    FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'ia4tube_social' AND r.relname = 'social_publications'`, [runtimeRole]);
  const acl = permissions.rows?.[0];
  if (!bindingColumnsMatch(columns.rows) || !bindingConstraintsMatch(constraints.rows) ||
      !bindingPoliciesMatch(policies.rows, runtimeRole) || permissions.rows?.length !== 1 ||
      acl.can_read !== true || acl.can_insert !== true || acl.can_update !== false) {
    postgresFail("postgres_publication_binding_schema_mismatch", "Contrato de vinculo da publicacao divergente.");
  }
  return Object.freeze({ profile: BINDING_PROFILE, bindingColumns: 2, bindingConstraints: 3, legacyRuntimeWriteBlocked: true });
}

module.exports = {
  BINDING_MIGRATION, BINDING_PROFILE, BINDING_SQL_SHA256, BINDING_COLUMNS, BINDING_CONSTRAINTS,
  bindingPoliciesMatch, bindingColumnsMatch, bindingConstraintsMatch, verifyPublicationBindingSchema
};
