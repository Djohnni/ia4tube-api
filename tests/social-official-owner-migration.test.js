"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const schema = require("../src/persistence/postgres/official-owner-schema");
const { readManifest, createMigrationRunner, validatePreparationStepRequest, targetFingerprint,
  APPLY_APPROVAL, PRODUCTION_APPROVAL, PREPARATION_PRODUCTION_TARGET } = require("../src/persistence/postgres/migrations");
const { SCHEMA_PROFILES, resolveSchemaProfile, normalizeEvidence } = require("../src/persistence/postgres/backup-restore");
const { officialOwnerRoutine, officialOwnerQueryFixture } = require("./helpers/official-owner-schema-fixtures");
const manifest = readManifest();
const asRows = count => manifest.slice(0, count).map(x => ({ version: x.version, checksum: x.sha256 }));
function request(index = 7) { return {
  resourceId: PREPARATION_PRODUCTION_TARGET.resourceId,
  expectedApplied: manifest.slice(0, index).map(x => x.version), migration: manifest[index].version,
  migrationSha256: manifest[index].sha256, fromProfile: `social-schema-000${index}`, toProfile: `social-schema-000${index + 1}`,
  beforeCatalogSha256: "1".repeat(64), afterCatalogSha256: "2".repeat(64),
  recoveryEvidenceDigest: "3".repeat(64), executionPackageDigest: "4".repeat(64)
}; }
test("0008 is one additive function; the seven historical SQL hashes remain exact", () => {
  assert.equal(manifest.length, 8);
  assert.deepEqual(manifest.slice(0, 7).map(x => x.sha256), [
    "ecab91eb1b915378b6d98edfa66c929c3558054349fbda8b25dbf274191a21bb",
    "72b05e7de90cd2d7742b5622bc92f9e9d78168317b9b7d547a5adb1b918d722d",
    "28e63269e5d31ebd05b49f24194be706d3e65eed3fa7f6b39f9051cfc9b96db7",
    "91f6efc611903c40e16bd37828d5b9c1a03dfae222e1d13b5dc97f81ffde1b5d",
    "ddac4a02cecfd5247432687289001aa3198cce4dccab4e45cedc4cff26e5da93",
    "f07eb68d37e8fec372e4b712447a113cba5d6ae6395492bb5678cc13d74948e7",
    "4747e001e3057b12facabb74f2529272d8c9cd4e933f55322ee9e3bc82483464"]);
  const sql = manifest[7].sql;
  assert.equal(crypto.createHash("sha256").update(sql).digest("hex"), schema.OFFICIAL_OWNER_SQL_SHA256);
  assert.equal((sql.match(/CREATE FUNCTION/g) || []).length, 1);
  assert.equal((sql.match(/INSERT INTO/g) || []).length, 3);
  assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|POLICY|ROLE|SCHEMA|EXTENSION)|\b(?:GRANT|REVOKE)\s+(?:INSERT|UPDATE|DELETE|ALL\s+ON\s+TABLE)|\bSET\s+row_security/i);
  assert.doesNotMatch(sql, /\b(?:UPDATE\s+ia4tube|DELETE\s+FROM|EXECUTE\s+format|ON\s+CONFLICT)\b/i);
  assert.ok(schema.officialOwnerBodyMatches(sql.split("$official_owner$")[1]));
});
test("the contract enforces both transaction scopes, safe digest, fixed label and null password", () => {
  const sql = manifest[7].sql;
  assert.match(sql, /current_setting\('ia4tube.company_id', TRUE\) IS DISTINCT FROM requested_company_id::TEXT/);
  assert.match(sql, /current_setting\('ia4tube.user_id', TRUE\) IS DISTINCT FROM requested_user_id::TEXT/);
  assert.match(sql, /pg_advisory_xact_lock\(pg_catalog.hashtextextended/);
  assert.match(sql, /pg_catalog.sha256\(pg_catalog.convert_to/);
  assert.match(sql, /expected_digest, NULL, 'active', 1/);
  assert.match(sql, /company_count <> 1 OR user_count <> 1 OR membership_count <> 1/);
  assert.match(sql, /existing_user.auth_version > 9007199254740991/);
});
test("official routine full catalog and body match", () => assert.equal(schema.officialOwnerRoutineMatches(officialOwnerRoutine()), true));
for (const [field, value] of Object.entries({ owner_name: "attacker", language: "sql", prosecdef: false,
  provolatile: "s", prokind: "p", proconfig: ["search_path=public"], proparallel: "s",
  proleakproof: true, proisstrict: true, proretset: false, pronargdefaults: 1, prosrc: "BEGIN RETURN; END;" })) {
  test(`routine rejects changed ${field}`, () => assert.equal(schema.officialOwnerRoutineMatches({ ...officialOwnerRoutine(), [field]: value }), false));
}
test("catalog checks use OIDs and require exact runtime-only execute with unchanged forced RLS/DML", async () => {
  const queries = [];
  const valid = await schema.verifyOfficialOwnerSchema({ async query(sql) { queries.push(sql); return officialOwnerQueryFixture(sql); } });
  assert.equal(valid.officialOwnerProvisioning, true); assert.equal(queries.length, 3);
  assert.ok(queries.every(sql => sql.startsWith("SELECT")));
  assert.match(queries[0], /has_function_privilege\(\$1, p.oid/);
  for (const alteration of [
    response => { response[0].rows.push({ ...response[0].rows[0] }); },
    response => { response[0].rows[0].runtime_execute = false; },
    response => { response[1].rows[0].grantee = "PUBLIC"; },
    response => { response[1].rows[0].is_grantable = true; },
    response => { response[2].rows[0].runtime_write = true; },
    response => { response[2].rows[0].relforcerowsecurity = false; }
  ]) {
    const responses = queries.map(officialOwnerQueryFixture); alteration(responses); let index = 0;
    await assert.rejects(schema.verifyOfficialOwnerSchema({ async query() { return responses[index++]; } }), { code: "postgres_official_owner_schema_mismatch" });
  }
});
test("profiles seven and eight stay distinct and eight adds authenticated function evidence", () => {
  const seven = resolveSchemaProfile(asRows(7)), eight = resolveSchemaProfile(asRows(8));
  assert.equal(seven.id, "social-schema-0007"); assert.equal(eight.id, schema.OFFICIAL_OWNER_PROFILE);
  assert.deepEqual(seven.backupTables, eight.backupTables);
  const data = count => { const profile = SCHEMA_PROFILES.find(x => x.id === `social-schema-000${count}`); return {
    migrations: asRows(count), tableCounts: profile.evidenceTables.map(table => ({ table, count: 0 })),
    catalog: { rlsTableCount: profile.rlsTables.length, forcedRlsTableCount: profile.rlsTables.length,
      transientPolicyCount: 0, canonicalRoleCount: 3, runtimeEscalationPossible: false, requiredConstraintsPresent: true,
      compatibleWith2A: true, publicationBindingSchemaVerified: true, policyDigest: "1".repeat(64), constraintDigest: "2".repeat(64), roleDigest: "3".repeat(64) }
  }; };
  assert.equal(Object.hasOwn(normalizeEvidence(data(7)).catalog, "officialOwnerSchemaVerified"), false);
  const current = data(8); assert.throws(() => normalizeEvidence(current), { code: "backup_catalog_state_invalid" });
  Object.assign(current.catalog, { officialOwnerSchemaVerified: true, officialOwnerRoutineSha256: schema.OFFICIAL_OWNER_BODY_SHA256 });
  assert.equal(normalizeEvidence(current).catalog.officialOwnerSchemaVerified, true);
  current.catalog.officialOwnerRoutineSha256 = "f".repeat(64);
  assert.throws(() => normalizeEvidence(current), { code: "backup_catalog_state_invalid" });
});
test("0008 exact next step accepts neither a gap nor modified pin", () => {
  assert.equal(validatePreparationStepRequest(request(), manifest).index, 7);
  for (const change of [{ expectedApplied: [] }, { migrationSha256: "f".repeat(64) }, { toProfile: "social-schema-0007" }]) {
    assert.throws(() => validatePreparationStepRequest({ ...request(), ...change }, manifest), { code: "migration_preparation_step_invalid" });
  }
});
test("production0008 cannot connect without independent recovery; local route cannot target production", async () => {
  let connections = 0;
  const target = { ...PREPARATION_PRODUCTION_TARGET, environment: "production", environmentId: "370d26ad-f135-4b82-9ad2-9cc3f6a149d0",
    username: "fixture_migration", approval: APPLY_APPROVAL, productionApproval: PRODUCTION_APPROVAL };
  const runner = createMigrationRunner({ pool: { async connect() { connections++; throw new Error("forbidden"); } }, target,
    ownerRole: "ia4tube_social_owner", migratorRole: "ia4tube_social_migrator" });
  const env = { SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target) };
  await assert.rejects(runner.applyProductionStep(request(), env), { code: "migration_preparation_recovery_verifier_required" });
  await assert.rejects(runner.applyOfficialOwnerProvisioning(request(), env), { code: "migration_exact_target_not_disposable" });
  assert.equal(connections, 0);
});
