"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  INITIAL_AUTHORIZATION_ID, INITIAL_AUTHORIZATION_SHA256, INITIAL_PRODUCTION_APPROVAL,
  INITIAL_TARGET, assertInitialProductionTarget, validateInitialProductionRequest, initialRecoveryDecision
} = require("../src/persistence/postgres/initial-production-recovery-exception");
const {
  APPLY_APPROVAL, PRODUCTION_APPROVAL, createMigrationRunner, readManifest, targetFingerprint,
  assertMigrationTarget, assertApplyTarget, validatePreparationStepRequest, assertPreparationLedger,
  readStagingExactCatalogSnapshot, stagingExactCatalogDigest
} = require("../src/persistence/postgres/migrations");
const { parseCommand, verifyLocalManifest } = require("../scripts/production-social-db-preflight");
const local = readManifest();
const ownerRole = "ia4tube_social_owner", migratorRole = "ia4tube_social_migrator";
const target = () => ({ ...INITIAL_TARGET, environment: "production", username: "synthetic_migration_login",
  environmentId: "a503e74f-d979-4c68-a286-c393a6650952", approval: APPLY_APPROVAL,
  productionApproval: INITIAL_PRODUCTION_APPROVAL });
const envFor = value => ({ SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(value) });
const ledgerRequest = () => ({ resourceId: INITIAL_TARGET.resourceId,
  beforeCatalogSha256: "1".repeat(64), afterCatalogSha256: "2".repeat(64), executionPackageDigest: "3".repeat(64),
  initialAuthorizationId: INITIAL_AUTHORIZATION_ID, initialAuthorizationSha256: INITIAL_AUTHORIZATION_SHA256 });
const stepRequest = (index = 0) => ({ ...ledgerRequest(), expectedApplied: local.slice(0, index).map(x => x.version),
  migration: local[index].version, migrationSha256: local[index].sha256,
  fromProfile: `social-schema-${String(index).padStart(4, "0")}`, toProfile: `social-schema-${String(index + 1).padStart(4, "0")}` });
const initialOptions = { production: true, initialRecoveryException: true };
function refusalHarness(value = target(), extra = {}) {
  let connections = 0;
  const runner = createMigrationRunner({ target: value, ownerRole, migratorRole,
    pool: { async connect() { connections++; throw Object.assign(new Error("synthetic_pool_boundary"), { code: "synthetic_pool_boundary" }); } }, ...extra });
  return { runner, env: envFor(value), connections: () => connections };
}

test("authority is exact, finite, initial-only and explicitly not a recovery PASS", () => {
  assert.equal(INITIAL_AUTHORIZATION_ID, "11c99ba1-a051-4358-b823-ab9d9c772b45");
  assert.equal(INITIAL_AUTHORIZATION_SHA256, "88b23e3672e9593a06513a0403fc7b7a503c578f5849f4448f204f38662b805e");
  const decision = initialRecoveryDecision();
  assert.equal(decision.status, "initial-owner-authorized-exception");
  for (const key of ["recoveryProven", "isolatedRestoreVerified", "collationCompatibilityResolved", "deletionAuthorized",
    "thirdPartyDataLossAuthorized", "futureDataProtectionWaived", "instagramExternalOperationsAuthorized"]) assert.equal(decision[key], false);
  assert.equal(decision.historicalOwnerTestDataRiskAccepted, true);
  assert.ok(Object.isFrozen(decision));
});

test("initial target refuses another resource, database, host, marker shape or login", () => {
  assert.doesNotThrow(() => assertInitialProductionTarget(target(), envFor(target()), targetFingerprint(target())));
  for (const change of [{ resourceId: "other" }, { host: INITIAL_TARGET.resourceId }, { host: "staging.invalid" },
    { database: "ia4tube_social_staging" }, { database: "ia4tube-social-production" }, { port: 5433 },
    { environment: "staging" }, { environmentId: "invalid" }, { username: undefined }, { username: "ia4tube_social_owner" }, { username: "pg_admin" }]) {
    const value = { ...target(), ...change };
    assert.throws(() => assertInitialProductionTarget(value, envFor(value), targetFingerprint(value)), { code: "migration_initial_target_mismatch" });
  }
});

test("fingerprint and both explicit approvals remain mandatory, without claiming verified backup", () => {
  assert.throws(() => assertInitialProductionTarget(target(), {}, targetFingerprint(target())), { code: "migration_target_not_verified" });
  for (const change of [{ approval: undefined }, { productionApproval: PRODUCTION_APPROVAL }, { productionApproval: undefined }]) {
    const value = { ...target(), ...change };
    assert.throws(() => assertInitialProductionTarget(value, envFor(value), targetFingerprint(value)), { code: "migration_initial_not_approved" });
  }
});

test("no global or existing migration approval accepts the new exception token", async () => {
  assert.throws(() => assertMigrationTarget(target(), envFor(target())), { code: "production_migration_not_approved" });
  assert.throws(() => assertApplyTarget(target(), envFor(target())), { code: "production_migration_not_approved" });
  const h = refusalHarness();
  await assert.rejects(h.runner.apply(h.env), { code: "production_migration_not_approved" });
  assert.equal(h.connections(), 0);
});

test("request refuses an altered authority, broad recovery flags or additional instructions", () => {
  for (const change of [{ initialAuthorizationId: "other" }, { initialAuthorizationSha256: "0".repeat(64) }]) {
    assert.throws(() => validateInitialProductionRequest({ ...stepRequest(), ...change }), { code: "migration_initial_authorization_mismatch" });
  }
  for (const field of ["recoveryEvidenceDigest", "recoveryVerified", "isolatedRestoreVerified", "skipTls", "sql", "allowDrop", "skipCatalog"]) {
    assert.throws(() => validateInitialProductionRequest({ ...stepRequest(), [field]: true }), { code: "migration_initial_request_invalid" });
  }
  const missing = stepRequest(); delete missing.initialAuthorizationId;
  assert.throws(() => validateInitialProductionRequest(missing), { code: "migration_initial_request_invalid" });
});

test("every exact missing 0001 through 0008 is accepted; ninth, gaps, changed checksums and old prefixes are refused", () => {
  assert.equal(local.length, 8);
  for (let i = 0; i < 8; i++) {
    const normalized = validatePreparationStepRequest(stepRequest(i), local, initialOptions);
    assert.equal(normalized.index, i);
    assert.equal(Object.hasOwn(normalized, "recoveryEvidenceDigest"), false);
  }
  for (const change of [{ migration: "0009_future" }, { expectedApplied: local.map(x => x.version) },
    { migrationSha256: "0".repeat(64) }, { expectedApplied: [local[1].version] }, { toProfile: "social-schema-0009" }]) {
    assert.throws(() => validatePreparationStepRequest({ ...stepRequest(), ...change }, local, initialOptions), { code: "migration_preparation_step_invalid" });
  }
  assert.throws(() => validatePreparationStepRequest(stepRequest(), local.slice(0, 7), initialOptions), { code: "migration_initial_manifest_invalid" });
  assert.throws(() => validatePreparationStepRequest(stepRequest(), [...local, local[7]], initialOptions), { code: "migration_preparation_manifest_mismatch" });
  assert.throws(() => validatePreparationStepRequest(stepRequest(), local, { ...initialOptions, production: false }), { code: "migration_initial_manifest_invalid" });
});

test("catalogue and execution-package digests are not waived", () => {
  for (const field of ["beforeCatalogSha256", "afterCatalogSha256", "executionPackageDigest"]) {
    for (const value of [undefined, "", "A".repeat(64)]) {
      assert.throws(() => validatePreparationStepRequest({ ...stepRequest(), [field]: value }, local, initialOptions), { code: "migration_preparation_evidence_required" });
    }
  }
});

test("default production apply still requires its independent recovery verifier", async () => {
  const value = { ...target(), productionApproval: PRODUCTION_APPROVAL };
  const h = refusalHarness(value);
  const request = stepRequest(); delete request.initialAuthorizationId; delete request.initialAuthorizationSha256;
  request.recoveryEvidenceDigest = "4".repeat(64);
  await assert.rejects(h.runner.applyProductionStep(request, h.env), { code: "migration_preparation_recovery_verifier_required" });
  assert.equal(h.connections(), 0);
});

test("named initial methods reach only the supplied pool without invoking or manufacturing recovery", async () => {
  let called = 0;
  const h = refusalHarness(target(), { verifyPreparationRecovery: () => { called++; throw new Error("not recovery"); } });
  for (const [method, request] of [["planInitialProductionStep", stepRequest()], ["applyInitialProductionStep", stepRequest()],
    ["planInitialProductionLedger", ledgerRequest()], ["initializeInitialProductionLedger", ledgerRequest()]]) {
    await assert.rejects(h.runner[method](request, h.env), { code: "synthetic_pool_boundary" });
  }
  assert.equal(called, 0); assert.equal(h.connections(), 4);
});

test("repeated, gapped or drifted journal cannot be repaired by the exception", () => {
  const rows = local.slice(0, 3).map(x => ({ version: x.version, checksum_sha256: x.sha256 }));
  assert.doesNotThrow(() => assertPreparationLedger(local, rows, 3));
  assert.throws(() => assertPreparationLedger(local, rows, 2), { code: "migration_preparation_journal_mismatch" });
  assert.throws(() => assertPreparationLedger(local, rows.slice(1), 3));
  assert.throws(() => assertPreparationLedger(local, [{ ...rows[0], checksum_sha256: "0".repeat(64) }], 1));
});

// Controlled SQL doubles exercise sequencing/refusals, NOT PostgreSQL, TLS,
// recovery or DDL semantics. No Client/Pool, process or network is instantiated.
async function sqlDouble({ ledger = false, change = () => undefined, failCommit = false } = {}) {
  const queries = [], rows = [];
  let released, commits = 0;
  const catalog = await readStagingExactCatalogSnapshot({ async query() { return { rows: [] }; } });
  const digest = stagingExactCatalogDigest(catalog);
  const one = value => ({ rows: [value] });
  const acl = privileges => ({ rows: privileges.map(privilege_type => ({ grantee: migratorRole, privilege_type, is_grantable: false, grantor_name: ownerRole })) });
  const client = { release(error) { released = { error }; }, async query(sql, args) {
    queries.push(sql);
    const altered = change(sql, args, { ledger, rows });
    if (altered !== undefined) return altered;
    if (sql.includes("AS target_exact")) return one({ target_exact: true, postgres_18: true, tls_active: true });
    if (sql.includes("AS owner_members_exact")) return one({ postgres_version_supported: true, database_owner_safe: true,
      login_is_separate: true, direct_connect_exact: true, public_database_acl_absent: true, database_temp_absent: true,
      can_migrate: true, migrator_members_exact: true, owner_members_exact: true });
    if (sql.includes("AS owns_database")) return one({});
    if (sql.includes("AS schema_owner_name")) return one({ schema_owner_name: ownerRole, routine_count: 0 });
    if (sql.includes("AS marker_kind")) return one({ marker_kind: "r", marker_owner_name: ownerRole });
    if (sql.startsWith("SELECT environment_id::text")) return one({ environment_id: target().environmentId, environment_name: "production" });
    if (sql.includes("AS ledger_absent")) return one({ ledger_absent: !ledger, social_schema_absent: true, other_relations_absent: true });
    if (sql.includes("AS exists")) return one({ exists: ledger });
    if (sql.includes("AS column_count_valid")) return one({ owned: true, column_count_valid: true, columns_valid: true,
      primary_key_valid: true, migrator_select: true, migrator_insert: true, migrator_update: false, migrator_delete: false });
    if (sql.includes("AS grantee") && sql.includes("expanded_acl.grantee <> namespace.nspowner")) return acl(["USAGE"]);
    if (sql.includes("AS grantee") && sql.includes("attribute.attacl")) return { rows: [] };
    if (sql.includes("AS grantee") && sql.includes("environment_identity")) return acl(["SELECT"]);
    if (sql.includes("AS grantee") && sql.includes("schema_migrations")) return acl(["INSERT", "SELECT"]);
    if (sql.startsWith("SELECT version, checksum_sha256")) return { rows: rows.map(x => ({ ...x })) };
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS ia4tube_migrations.schema_migrations")) ledger = true;
    if (sql.startsWith("INSERT INTO ia4tube_migrations.schema_migrations")) rows.push({ version: args[0], checksum_sha256: args[1] });
    if (sql.includes("AS unlocked")) return one({ unlocked: true });
    if (sql === "COMMIT") { commits++; if (failCommit) throw new Error("synthetic_commit_transport_loss"); }
    return { rows: [] };
  } };
  const value = target();
  const runner = createMigrationRunner({ target: value, ownerRole, migratorRole, pool: { async connect() { return client; } } });
  return { runner, env: envFor(value), request: { ...ledgerRequest(), beforeCatalogSha256: digest, afterCatalogSha256: digest },
    step: { ...stepRequest(), beforeCatalogSha256: digest, afterCatalogSha256: digest },
    queries, released: () => released, commits: () => commits };
}

test("read-only initial ledger plan changes no journal, ACL or schema", async () => {
  const h = await sqlDouble();
  const result = await h.runner.planInitialProductionLedger(h.request, h.env);
  assert.equal(result.applyAuthorized, false); assert.equal(result.readOnly, true);
  assert.equal(result.recoveryDecision.recoveryProven, false);
  assert.equal(h.queries.filter(x => x.startsWith("BEGIN")).length, 1);
  assert.ok(h.queries.includes("ROLLBACK"));
  assert.ok(h.queries.every(x => !/^(?:CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|COMMIT)\b/.test(x)));
  assert.ok(h.released());
});

test("ledger bootstrap reuses canonical DDL once, validates empty journal and performs postcommit read-only validation", async () => {
  const h = await sqlDouble();
  const result = await h.runner.initializeInitialProductionLedger(h.request, h.env);
  assert.equal(result.postCommitValidated, true); assert.deepEqual(result.appliedMigrations, []);
  assert.equal(result.recoveryDecision.isolatedRestoreVerified, false);
  assert.equal(h.queries.filter(x => x.startsWith("CREATE TABLE IF NOT EXISTS")).length, 1);
  assert.equal(h.queries.filter(x => x.startsWith("BEGIN")).length, 2);
  assert.equal(h.commits(), 1); assert.equal(h.queries.some(x => x.startsWith("INSERT")), false);
  assert.equal(h.queries.at(-1).includes("advisory_unlock"), true); assert.ok(h.released());
});

test("ledger bootstrap refuses an existing ledger before any DDL or ACL repair", async () => {
  const h = await sqlDouble({ ledger: true });
  await assert.rejects(h.runner.initializeInitialProductionLedger(h.request, h.env), { code: "migration_initial_ledger_not_absent" });
  assert.ok(h.queries.includes("ROLLBACK")); assert.equal(h.commits(), 0);
  assert.ok(h.queries.every(x => !/^(?:CREATE|GRANT|REVOKE)\b/.test(x))); assert.ok(h.released());
});

test("one exact initial migration uses unchanged SQL, writes one journal entry and validates after commit", async () => {
  const h = await sqlDouble({ ledger: true });
  const result = await h.runner.applyInitialProductionStep(h.step, h.env);
  assert.equal(result.appliedMigration, local[0].version); assert.equal(result.postCommitValidated, true);
  assert.equal(result.recoveryDecision.recoveryProven, false);
  assert.equal(h.queries.filter(x => x === local[0].sql).length, 1);
  assert.equal(h.queries.filter(x => x.startsWith("INSERT INTO ia4tube_migrations.schema_migrations")).length, 1);
  assert.equal(h.commits(), 1); assert.ok(h.released());
});

for (const [label, change, code] of [
  ["TLS", sql => sql.includes("AS target_exact") ? { rows: [{ target_exact: true, postgres_18: true, tls_active: false }] } : undefined, "migration_preparation_session_mismatch"],
  ["target session", sql => sql.includes("AS target_exact") ? { rows: [{ target_exact: false, postgres_18: true, tls_active: true }] } : undefined, "migration_preparation_session_mismatch"],
  ["PG18", sql => sql.includes("AS target_exact") ? { rows: [{ target_exact: true, postgres_18: false, tls_active: true }] } : undefined, "migration_preparation_session_mismatch"],
  ["privileged migration login", sql => sql.includes("AS owner_members_exact") ? { rows: [{ rolsuper: true }] } : undefined, "migration_session_role_unsafe"],
  ["marker", sql => sql.startsWith("SELECT environment_id::text") ? { rows: [{ environment_id: target().environmentId, environment_name: "staging" }] } : undefined, "migration_environment_marker_mismatch"]
]) test(`both initial writes still refuse ${label} and roll back without DDL`, async () => {
  for (const ledger of [false, true]) {
    const h = await sqlDouble({ ledger, change });
    await assert.rejects(ledger ? h.runner.applyInitialProductionStep(h.step, h.env) : h.runner.initializeInitialProductionLedger(h.request, h.env), { code });
    assert.ok(h.queries.includes("ROLLBACK")); assert.equal(h.commits(), 0);
    assert.ok(h.queries.every(x => !/^(?:CREATE|INSERT|GRANT|REVOKE)\b/.test(x))); assert.ok(h.released());
  }
});

test("before-catalog drift is refused and after-catalog drift rolls back the operation", async () => {
  for (const field of ["beforeCatalogSha256", "afterCatalogSha256"]) for (const ledger of [false, true]) {
    const h = await sqlDouble({ ledger });
    const request = { ...(ledger ? h.step : h.request), [field]: "f".repeat(64) };
    await assert.rejects(ledger ? h.runner.applyInitialProductionStep(request, h.env) : h.runner.initializeInitialProductionLedger(request, h.env), { code: "migration_preparation_catalog_mismatch" });
    assert.ok(h.queries.includes("ROLLBACK")); assert.equal(h.commits(), 0); assert.ok(h.released());
  }
});

test("uncertain COMMIT never rolls back, retries or unlocks on a possibly broken session", async () => {
  for (const ledger of [false, true]) {
    const h = await sqlDouble({ ledger, failCommit: true });
    await assert.rejects(ledger ? h.runner.applyInitialProductionStep(h.step, h.env) : h.runner.initializeInitialProductionLedger(h.request, h.env), error => {
      assert.equal(error.code, "migration_preparation_commit_outcome_unknown");
      assert.equal(error.outcomeUnknown, true); assert.equal(error.retryAllowed, false);
      assert.equal(error.requiresReadOnlyInspection, true); return true;
    });
    assert.equal(h.queries.includes("ROLLBACK"), false);
    assert.equal(h.queries.some(x => x.includes("advisory_unlock")), false);
    assert.equal(h.commits(), 1); assert.equal(h.released().error.discardClient, true);
  }
});

test("preflight stays inspect-only and the eight SQL pins/bytes are still valid", () => {
  assert.doesNotThrow(() => parseCommand(["inspect"]));
  assert.throws(() => parseCommand(["apply"]), { code: "production_preflight_inspect_only" });
  assert.doesNotThrow(() => verifyLocalManifest());
  const source = fs.readFileSync(path.join(__dirname, "../scripts/production-social-db-preflight.js"), "utf8");
  assert.match(source, /recovery_not_proven_by_this_preflight/);
  assert.match(source, /production_apply_not_exposed_by_readonly_operator/);
  assert.doesNotMatch(source, /initialRecoveryDecision|applyInitialProductionStep/);
});
