BEGIN;

DROP POLICY IF EXISTS legacy_entity_mappings_company_scope
  ON legacy_entity_mappings;
DROP POLICY IF EXISTS company_memberships_company_scope
  ON company_memberships;
DROP POLICY IF EXISTS companies_company_scope
  ON companies;

DROP TABLE IF EXISTS legacy_entity_mappings;
DROP TABLE IF EXISTS company_memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS schema_migrations;

COMMIT;
