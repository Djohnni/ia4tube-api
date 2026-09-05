"use strict";

function bindingColumns() {
  return [
    { column_name: "bound_external_account_id", data_type: "uuid" },
    { column_name: "expected_connection_revision", data_type: "bigint" }
  ].map((row) => ({ ...row, not_null: false, has_default: false, generated: "", identity: "" }));
}
function bindingConstraints() {
  return [
    { constraint_name: "social_publications_binding_pair", constraint_type: "c",
      expression: "((bound_external_account_id IS NULL) = (expected_connection_revision IS NULL))" },
    { constraint_name: "social_publications_binding_revision_valid", constraint_type: "c",
      expression: "((expected_connection_revision IS NULL) OR ((expected_connection_revision >= 1) AND (expected_connection_revision <= '9007199254740991'::bigint)))" },
    { constraint_name: "social_publications_bound_account_fk", constraint_type: "f", expression: null,
      foreign_schema: "ia4tube_social", foreign_table: "social_external_accounts", delete_action: "r", update_action: "a", match_type: "s",
      columns: ["company_id", "connection_id", "bound_external_account_id"], foreign_columns: ["company_id", "connection_id", "id"] }
  ].map((row) => ({ ...row, validated: true, deferrable: false, initially_deferred: false }));
}
function bindingPolicies() {
  const expression = "((bound_external_account_id IS NOT NULL) AND (expected_connection_revision IS NOT NULL))";
  return ["INSERT", "UPDATE"].map((cmd) => ({
    tablename: "social_publications", policyname: `social_publications_bound_${cmd.toLowerCase()}`,
    permissive: "RESTRICTIVE", roles: ["ia4tube_social_runtime"], cmd,
    qual: cmd === "UPDATE" ? expression : null, with_check: expression
  }));
}
function bindingQueryFixture(text) {
  if (text.includes("a.attname AS column_name")) return { rows: bindingColumns() };
  if (text.includes("c.conname AS constraint_name")) return { rows: bindingConstraints() };
  if (text.includes("policyname IN ('social_publications_bound_insert'")) return { rows: bindingPolicies() };
  if (text.includes("AS can_read")) return { rows: [{ can_read: true, can_insert: true, can_update: false }] };
  return null;
}
module.exports = { bindingColumns, bindingConstraints, bindingPolicies, bindingQueryFixture };
