"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const {
  BINDING_MIGRATION, BINDING_PROFILE, BINDING_SQL_SHA256,
  bindingColumnsMatch, bindingConstraintsMatch, bindingPoliciesMatch, verifyPublicationBindingSchema
} = require("../src/persistence/postgres/publication-binding-schema");
const {
  APPLY_APPROVAL, PRODUCTION_APPROVAL, PREPARATION_PRODUCTION_TARGET,
  createMigrationRunner, readManifest, validatePreparationStepRequest,
  assertPreparationLedger, assertPreparationProductionTarget, targetFingerprint
} = require("../src/persistence/postgres/migrations");
const { resolveSchemaProfile, SCHEMA_PROFILES, normalizeEvidence } = require("../src/persistence/postgres/backup-restore");
const { bindingColumns, bindingConstraints, bindingPolicies, bindingQueryFixture } = require("./helpers/publication-binding-schema-fixtures");
const root = path.resolve(__dirname, "..");
const historicalPins = [
  "ecab91eb1b915378b6d98edfa66c929c3558054349fbda8b25dbf274191a21bb",
  "72b05e7de90cd2d7742b5622bc92f9e9d78168317b9b7d547a5adb1b918d722d",
  "28e63269e5d31ebd05b49f24194be706d3e65eed3fa7f6b39f9051cfc9b96db7",
  "91f6efc611903c40e16bd37828d5b9c1a03dfae222e1d13b5dc97f81ffde1b5d",
  "ddac4a02cecfd5247432687289001aa3198cce4dccab4e45cedc4cff26e5da93",
  "f07eb68d37e8fec372e4b712447a113cba5d6ae6395492bb5678cc13d74948e7"
];
const digest = "1".repeat(64);
// This historical suite remains explicitly scoped to the immutable 0007 prefix.
const local = readManifest().slice(0, 7);
function request(index = 6) {
  return {
    resourceId: PREPARATION_PRODUCTION_TARGET.resourceId,
    expectedApplied: local.slice(0, index).map((entry) => entry.version),
    migration: local[index].version, migrationSha256: local[index].sha256,
    fromProfile: `social-schema-${String(index).padStart(4, "0")}`,
    toProfile: `social-schema-${String(index + 1).padStart(4, "0")}`,
    beforeCatalogSha256: digest, afterCatalogSha256: "2".repeat(64),
    recoveryEvidenceDigest: "3".repeat(64), executionPackageDigest: "4".repeat(64)
  };
}
const productionTarget = () => ({
  ...PREPARATION_PRODUCTION_TARGET, environment: "production",
  environmentId: "370d26ad-f135-4b82-9ad2-9cc3f6a149d0", username: "fixture_migrator",
  approval: APPLY_APPROVAL, productionApproval: PRODUCTION_APPROVAL
});
function runnerHarness(target = productionTarget(), extra = {}) {
  let connected = 0;
  const runner = createMigrationRunner({
    pool: { async connect() { connected += 1; throw new Error("No physical database in this test"); } },
    target, ownerRole: "ia4tube_social_owner", migratorRole: "ia4tube_social_migrator", ...extra
  });
  return { runner, connected: () => connected, env: { SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target) } };
}

test("0007 follows the actual six-file history without changing any historical byte", () => {
  assert.equal(local.length, 7);
  local.slice(0, 6).forEach((migration, index) => {
    const bytes = fs.readFileSync(path.join(root, "db/migrations", migration.file));
    assert.equal(bytes.includes(13), false);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), historicalPins[index]);
  });
  assert.equal(local[6].version, BINDING_MIGRATION);
  assert.equal(local[6].sha256, BINDING_SQL_SHA256);
});

test("SQL is limited to two nullable fields, three constraints and two restrictive policies", () => {
  const sql = local[6].sql;
  assert.equal((sql.match(/ADD COLUMN/g) || []).length, 2);
  assert.equal((sql.match(/ADD CONSTRAINT/g) || []).length, 3);
  assert.equal((sql.match(/CREATE POLICY/g) || []).length, 2);
  assert.equal((sql.match(/AS RESTRICTIVE/g) || []).length, 2);
  assert.doesNotMatch(sql, /\b(?:DEFAULT|UPDATE\s+ia4tube|DROP|GRANT|REVOKE|DISABLE|CASCADE|TRIGGER|FUNCTION)\b/i);
  assert.match(sql, /REFERENCES ia4tube_social\.social_external_accounts\(company_id, connection_id, id\)/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.match(sql, /expected_connection_revision <= 9007199254740991/);
  const doc = fs.readFileSync(path.join(root, "docs/social-publication-binding-migration-0007.md"), "utf8");
  assert.ok(doc.includes(BINDING_SQL_SHA256));
  assert.ok(doc.includes(sql.trim()));
});

test("schema columns have exact types, no defaults, generated values or forced backfill", () => {
  assert.equal(bindingColumnsMatch(bindingColumns()), true);
  for (const [key, value] of [["data_type", "text"], ["not_null", true], ["has_default", true], ["generated", "s"], ["identity", "a"]]) {
    const columns = bindingColumns(); columns[0][key] = value;
    assert.equal(bindingColumnsMatch(columns), false);
  }
  assert.equal(bindingColumnsMatch(bindingColumns().slice(0, 1)), false);
});

test("constraints require exact tenant/account FK, bounded revision and both-or-neither binding", () => {
  assert.equal(bindingConstraintsMatch(bindingConstraints()), true);
  for (const mutate of [
    (rows) => { rows[0].expression = "TRUE"; },
    (rows) => { rows[1].expression = "expected_connection_revision > 0"; },
    (rows) => { rows[2].columns = ["bound_external_account_id"]; },
    (rows) => { rows[2].foreign_table = "social_connections"; },
    (rows) => { rows[2].delete_action = "c"; },
    (rows) => { rows[2].validated = false; },
    (rows) => { rows[2].deferrable = true; }
  ]) {
    const rows = bindingConstraints(); mutate(rows);
    assert.equal(bindingConstraintsMatch(rows), false);
  }
});

test("binding policies cannot weaken tenant scope or permit legacy runtime mutation", () => {
  assert.equal(bindingPoliciesMatch(bindingPolicies()), true);
  for (const mutate of [
    (rows) => { rows[0].permissive = "PERMISSIVE"; },
    (rows) => { rows[0].roles = ["public"]; },
    (rows) => { rows[1].qual = "true"; },
    (rows) => { rows[1].with_check = "true"; },
    (rows) => { rows[1].cmd = "ALL"; },
    (rows) => { rows[0].qual = "true"; }
  ]) {
    const rows = bindingPolicies(); mutate(rows);
    assert.equal(bindingPoliciesMatch(rows), false);
  }
});

test("real validator requires exact catalogue and refuses effective UPDATE of either field", async () => {
  const queries = [];
  const good = { async query(text) { queries.push(text); return bindingQueryFixture(text); } };
  const report = await verifyPublicationBindingSchema(good);
  assert.equal(report.profile, BINDING_PROFILE);
  assert.equal(report.legacyRuntimeWriteBlocked, true);
  assert.equal(queries.length, 4);
  assert.ok(queries.every((query) => query.startsWith("SELECT")));
  assert.match(queries[3], /has_column_privilege\(\$1, r\.oid,/);
  assert.doesNotMatch(queries[3], /has_column_privilege\(\$1, 'ia4tube_social/);
  const unsafe = { async query(text) {
    if (text.includes("AS can_read")) return { rows: [{ can_read: true, can_insert: true, can_update: true }] };
    return bindingQueryFixture(text);
  } };
  await assert.rejects(verifyPublicationBindingSchema(unsafe), { code: "postgres_publication_binding_schema_mismatch" });
});

test("backup recognizes distinct 0006 and 0007 profiles with identical data-table sets", () => {
  const asRows = (count) => local.slice(0, count).map((entry) => ({ version: entry.version, checksum: entry.sha256 }));
  const before = resolveSchemaProfile(asRows(6)), after = resolveSchemaProfile(asRows(7));
  assert.equal(before.id, "social-schema-0006");
  assert.equal(after.id, BINDING_PROFILE);
  assert.deepEqual(after.backupTables, before.backupTables);
  assert.deepEqual(after.rlsTables, before.rlsTables);
  assert.equal(SCHEMA_PROFILES.find((entry) => entry.id === BINDING_PROFILE).migrationRows.length, 7);
  const drift = asRows(7); drift[6].checksum = digest;
  assert.throws(() => resolveSchemaProfile(drift), { code: "backup_migration_state_invalid" });
});

test("production step requires one exact next version and independently pinned SQL", () => {
  for (let index = 0; index < 7; index += 1) assert.equal(validatePreparationStepRequest(request(index), local).index, index);
  for (const change of [
    { migration: local[5].version }, { migrationSha256: digest }, { expectedApplied: [] },
    { fromProfile: "social-schema-0005" }, { toProfile: "social-schema-0008" }
  ]) assert.throws(() => validatePreparationStepRequest({ ...request(), ...change }, local), { code: "migration_preparation_step_invalid" });
  const changedManifest = local.map((entry, index) => index === 6 ? { ...entry, sha256: digest } : entry);
  assert.throws(() => validatePreparationStepRequest(request(), changedManifest), { code: "migration_preparation_manifest_mismatch" });
});

test("0007 backup evidence requires binding schema proof without rewriting historical 0006 evidence", () => {
  function evidence(count) {
    const profile = SCHEMA_PROFILES.find((entry) => entry.id === `social-schema-000${count}`);
    return {
      migrations: local.slice(0, count).map((entry) => ({ version: entry.version, checksum: entry.sha256 })),
      tableCounts: profile.evidenceTables.map((table) => ({ table, count: 0 })),
      catalog: {
        rlsTableCount: profile.rlsTables.length, forcedRlsTableCount: profile.rlsTables.length,
        transientPolicyCount: 0, canonicalRoleCount: 3, runtimeEscalationPossible: false,
        requiredConstraintsPresent: true, compatibleWith2A: true,
        policyDigest: digest, constraintDigest: digest, roleDigest: digest
      }
    };
  }
  const historical = normalizeEvidence(evidence(6));
  assert.equal(Object.hasOwn(historical.catalog, "publicationBindingSchemaVerified"), false);
  const current = evidence(7);
  assert.throws(() => normalizeEvidence(current), { code: "backup_catalog_state_invalid" });
  current.catalog.publicationBindingSchemaVerified = true;
  assert.equal(normalizeEvidence(current).catalog.publicationBindingSchemaVerified, true);
});

test("production step refuses missing evidence and arbitrary resource identity", () => {
  for (const field of ["resourceId", "beforeCatalogSha256", "afterCatalogSha256", "recoveryEvidenceDigest", "executionPackageDigest"]) {
    assert.throws(() => validatePreparationStepRequest({ ...request(), [field]: undefined }, local), { code: "migration_preparation_evidence_required" });
  }
  const target = productionTarget();
  assert.doesNotThrow(() => assertPreparationProductionTarget(target, { SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target) }));
  for (const change of [{ environment: "staging" }, { host: "another.invalid" }, { database: "another_database" }, { port: 5433 }]) {
    const altered = { ...target, ...change };
    assert.throws(() => assertPreparationProductionTarget(altered, { SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(altered) }), { code: "migration_preparation_target_mismatch" });
  }
});

test("no callback or unauthenticated recovery claim can reach a production pool", async () => {
  const missing = runnerHarness();
  await assert.rejects(missing.runner.applyProductionStep(request(), missing.env), { code: "migration_preparation_recovery_verifier_required" });
  assert.equal(missing.connected(), 0);
  const falseClaim = runnerHarness(productionTarget(), { verifyPreparationRecovery: async () => ({ verified: true }) });
  await assert.rejects(falseClaim.runner.applyProductionStep(request(), falseClaim.env), { code: "migration_preparation_recovery_invalid" });
  assert.equal(falseClaim.connected(), 0);
});

test("the isolated 0007 route cannot act on production or staging", async () => {
  const production = runnerHarness();
  await assert.rejects(production.runner.applyPublicationBinding(request(), production.env), { code: "migration_exact_target_not_disposable" });
  assert.equal(production.connected(), 0);
  const stage = runnerHarness({ ...productionTarget(), environment: "staging", database: "ia4tube_social_staging" });
  await assert.rejects(stage.runner.applyPublicationBinding(request(), stage.env), { code: "migration_exact_target_not_disposable" });
  assert.equal(stage.connected(), 0);
});

test("journal resume rejects an already applied step, a gap and checksum drift", () => {
  const rows = local.slice(0, 6).map((entry) => ({ version: entry.version, checksum_sha256: entry.sha256 }));
  assert.equal(assertPreparationLedger(local, rows, 6).length, 7);
  assert.throws(() => assertPreparationLedger(local, [...rows, { version: local[6].version, checksum_sha256: local[6].sha256 }], 6), { code: "migration_preparation_journal_mismatch" });
  assert.throws(() => assertPreparationLedger(local, rows.slice(1), 6));
  const drift = rows.map((row) => ({ ...row })); drift[0].checksum_sha256 = digest;
  assert.throws(() => assertPreparationLedger(local, drift, 6));
});
