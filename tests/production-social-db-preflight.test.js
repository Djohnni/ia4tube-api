"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  TARGET, READ_APPROVAL, CANONICAL_ROLES, MIGRATIONS, SQL,
  parseCommand, parseConnection, loadConnectionOptions, verifyLocalManifest,
  summarizeSnapshot, inspectConnectedClient, inspectClientLifecycle, safeFailure, main
} = require("../scripts/production-social-db-preflight");

// Entirely synthetic credentials/catalogue. No pg Client, socket or database.
const SYNTHETIC_PASSWORD = "fixture-only-not-a-real-password";
const url = (host = TARGET.externalHostname) =>
  `postgresql://fixture_operator:${SYNTHETIC_PASSWORD}@${host}:5432/${TARGET.database}?sslmode=verify-full`;
const environment = () => ({
  PRODUCTION_SOCIAL_PREFLIGHT_APPROVED: READ_APPROVAL,
  PRODUCTION_SOCIAL_PREFLIGHT_DATABASE_URL: url()
});
const matchesCode = (code) => (error) => error.code === code && error.message === code;
const identity = () => ({
  database_name: TARGET.database, server_version_num: 180004,
  transaction_read_only: "on", transaction_isolation: "repeatable read",
  principal_matches: true, session_is_database_owner: true,
  session_superuser: false, session_bypass_rls: false,
  session_create_role: true, session_create_database: true, ssl_in_use: true
});
const catalogue = () => ({
  social_schema_count: 0, other_schema_count: 0, user_relation_count: 0,
  other_relation_count: 0, other_function_count: 0, other_type_count: 0,
  other_extension_count: 0,
  ledger_exists: false, ledger_is_table: false, ledger_readable: false,
  marker_exists: false, marker_is_table: false, marker_readable: false,
  public_database_connect: true, public_schema_create: false
});
const snapshot = () => ({ identity: identity(), catalogue: catalogue(), roles: [], ledger: null, marker: null });
const role = (name) => ({
  role_name: name, can_login: false, is_superuser: false, bypass_rls: false,
  create_database: false, create_role: false, inherits: false, replication: false, member_count: 0
});
function populatedSnapshot() {
  const value = snapshot();
  Object.assign(value.catalogue, {
    social_schema_count: 3, user_relation_count: 40,
    ledger_exists: true, ledger_is_table: true, ledger_readable: true,
    marker_exists: true, marker_is_table: true, marker_readable: true
  });
  value.roles = CANONICAL_ROLES.map(role);
  value.ledger = MIGRATIONS.map((entry) => ({ version: entry.version, checksum_sha256: entry.sha256 }));
  value.marker = [{ environment_id: "730d26ad-f135-4b82-9ad2-9cc3f6a149d0", environment_name: "production" }];
  return value;
}
function fakeClient(value = snapshot(), failSql = null, failRollback = false) {
  const transcript = [];
  const data = new Map([
    [SQL.identity, [value.identity]], [SQL.catalogue, [value.catalogue]],
    [SQL.roles, value.roles], [SQL.ledger, value.ledger], [SQL.marker, value.marker]
  ]);
  return {
    transcript,
    async query(text, parameters) {
      transcript.push({ text, parameters });
      if (text === failSql || (text === SQL.rollback && failRollback)) {
        throw new Error(`synthetic raw database failure ${url()}`);
      }
      if (text === SQL.begin || text === SQL.rollback) return { rows: [] };
      assert.ok(data.has(text), "only fixed catalogue/metadata statements are permitted");
      return { rows: data.get(text) };
    }
  };
}

test("only the exact inspect command exists; apply/backup/restore and flags are refused", async () => {
  assert.equal(parseCommand(["inspect"]), "inspect");
  for (const args of [[], ["apply"], ["migrate"], ["backup"], ["restore"], ["inspect", "--apply"], ["inspect", "--url=x"]]) {
    assert.throws(() => parseCommand(args), matchesCode("production_preflight_inspect_only"));
    await assert.rejects(main(args, {}), matchesCode("production_preflight_inspect_only"));
  }
});

test("the observed production identity and fingerprint are fixed", () => {
  assert.equal(TARGET.resourceId, "dpg-dae4tmf40ujc73dr2dog-a");
  assert.equal(TARGET.internalHostname, TARGET.resourceId);
  assert.equal(TARGET.externalHostname, "dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com");
  assert.equal(TARGET.fingerprint, "6d21299b8c02250cf3493128557f52ff95e83397cba4d92dccaa52996485c17c");
  assert.equal(TARGET.database, "ia4tube_social_production");
  assert.equal(TARGET.port, 5432);
});

test("a missing externally confirmed hostname never falls back to the internal hostname", () => {
  assert.throws(() => parseConnection(url(), null), matchesCode("production_preflight_external_hostname_unconfirmed"));
  assert.throws(() => parseConnection(url(TARGET.internalHostname), TARGET.externalHostname), matchesCode("production_preflight_connection_invalid"));
});

test("strict explicit TLS connection options retain the production fingerprint", () => {
  const options = loadConnectionOptions(environment());
  assert.equal(options.host, TARGET.externalHostname);
  assert.equal(options.database, TARGET.database);
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.servername, TARGET.externalHostname);
  assert.equal(options.ssl.minVersion, "TLSv1.2");
  assert.equal(typeof options.ssl.checkServerIdentity, "function");
  assert.match(options.options, /default_transaction_read_only=on/);
  assert.match(options.options, /search_path=pg_catalog/);
  assert.equal(options.query_timeout, 10000);
  assert.equal(options.connectionTimeoutMillis, 5000);
  assert.equal(options.ssl.ca, undefined);
  assert.equal(options.connectionString, undefined);
});

test("missing approval cannot load the connection", () => {
  assert.throws(() => loadConnectionOptions({ PRODUCTION_SOCIAL_PREFLIGHT_DATABASE_URL: url() }), matchesCode("production_preflight_approval_missing"));
});

test("staging, arbitrary hosts, default ports, ambiguous URL and insecure TLS are rejected", () => {
  const invalid = [
    url("staging.invalid"), url().replace(TARGET.database, "ia4tube_social_staging"),
    url().replace(":5432/", ":5433/"), url().replace(":5432/", "/"),
    url().replace("verify-full", "require"), url().replace("verify-full", "disable"),
    url() + "&sslmode=verify-full", url() + "&options=-c%20search_path=public", url() + "#fragment",
    url().replace(`${SYNTHETIC_PASSWORD}@`, "@"), url().replace("fixture_operator", "wrong-user"),
    url().replace(SYNTHETIC_PASSWORD, "%00"), url().replace("postgresql:", "https:"),
    ` ${url()}`, `${url()}\n`, undefined
  ];
  for (const value of invalid) {
    assert.throws(() => parseConnection(value, TARGET.externalHostname), matchesCode("production_preflight_connection_invalid"));
  }
});

test("libpq, Node and OpenSSL ambient overrides are refused without disclosing them", () => {
  for (const name of ["PGHOST", "PGPASSWORD", "PGSERVICEFILE", "pgoptions", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "OPENSSL_CONF"]) {
    assert.throws(() => loadConnectionOptions({ ...environment(), [name]: "fixture-private-value" }), matchesCode("production_preflight_environment_override_refused"));
  }
  assert.throws(() => loadConnectionOptions({ ...environment(), SOCIAL_DATABASE_CA_FILE: "fixture-private-path" }), matchesCode("production_preflight_tls_required"));
});

test("six historical and one additive local SQL files match their immutable pins", () => {
  assert.equal(MIGRATIONS.length, 7);
  for (const entry of MIGRATIONS) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyLocalManifest(), true);
});

test("manifest reordering, additional fields or drift fail before any database access", () => {
  const variants = [
    { format: 2, migrations: MIGRATIONS },
    { format: 1, migrations: [...MIGRATIONS].reverse() },
    { format: 1, migrations: MIGRATIONS.map((entry) => ({ ...entry, sql: "do-not-run" })) },
    { format: 1, migrations: MIGRATIONS.slice(0, 5) }
  ];
  for (const manifest of variants) {
    assert.throws(() => verifyLocalManifest({ readFile: () => JSON.stringify(manifest) }), matchesCode("production_preflight_manifest_invalid"));
  }
  assert.throws(() => verifyLocalManifest({ readFile: () => "not-json" }), matchesCode("production_preflight_manifest_invalid"));
});

test("actual SQL bytes must match pins, not merely checksums.json", () => {
  assert.throws(() => verifyLocalManifest({ readFile: (name) => path.basename(name) === "checksums.json"
    ? JSON.stringify({ format: 1, migrations: MIGRATIONS }) : Buffer.from("altered fixture SQL")
  }), matchesCode("production_preflight_local_checksum_mismatch"));
});

test("an empty catalogue is only a baseline candidate and never apply or recovery approval", () => {
  const report = summarizeSnapshot(snapshot());
  assert.equal(report.ok, true);
  assert.equal(report.baselineCandidate, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.applyAvailable, false);
  assert.equal(report.environmentIdentityComparedWithApprovedUuid, false);
  assert.equal(report.pendingMigrations.length, 7);
  assert.ok(report.blockers.includes("recovery_not_proven_by_this_preflight"));
  assert.ok(report.blockers.includes("production_apply_not_exposed_by_readonly_operator"));
  assert.ok(report.blockers.includes("production_0007_isolated_recovery_and_review_required"));
  assert.ok(report.blockers.includes("production_0005_0006_route_review_required"));
  assert.ok(report.blockers.includes("runtime_rls_and_cross_tenant_behavior_not_proven"));
});

test("unexpected catalogue objects and role attributes are counts/flags, not a readiness claim", () => {
  const value = snapshot();
  value.catalogue.other_relation_count = 1;
  value.catalogue.user_relation_count = 1;
  value.catalogue.private_object_name = "fixture-private-object";
  value.roles = [{ ...role(CANONICAL_ROLES[0]), can_login: true, member_count: 2 }];
  const report = summarizeSnapshot(value);
  assert.equal(report.baselineCandidate, false);
  assert.equal(report.canonicalRoles[0].restrictedNoLoginAttributes, false);
  assert.ok(report.blockers.includes("unexpected_catalogue_objects_require_review"));
  assert.ok(report.blockers.includes("canonical_role_attributes_require_review"));
  assert.doesNotMatch(JSON.stringify(report), /fixture-private-object/);
});

test("an existing exact ledger and production marker are inspected without exposing their UUID", () => {
  const report = summarizeSnapshot(populatedSnapshot());
  assert.equal(report.ledgerChecksumsVerified, true);
  assert.deepEqual(report.pendingMigrations, []);
  assert.equal(report.appliedMigrations.length, 7);
  assert.equal(report.environmentMarkerProductionAndUuidValid, true);
  assert.equal(report.environmentIdentityComparedWithApprovedUuid, false);
  assert.equal(report.baselineCandidate, false);
  assert.doesNotMatch(JSON.stringify(report), /730d26ad/);
});

test("ledger drift, gaps, duplicates and unknown migrations fail closed", () => {
  for (const change of [
    (value) => { value.ledger[0].checksum_sha256 = "0".repeat(64); },
    (value) => { value.ledger.shift(); },
    (value) => { value.ledger.push(value.ledger[0]); },
    (value) => { value.ledger[0].version = "fixture_unknown"; }
  ]) {
    const value = populatedSnapshot(); change(value);
    assert.throws(() => summarizeSnapshot(value), matchesCode("production_preflight_ledger_mismatch"));
  }
});

test("a staging or malformed environment marker cannot pass as production", () => {
  for (const marker of [[], [{ environment_name: "staging", environment_id: "730d26ad-f135-4b82-9ad2-9cc3f6a149d0" }], [{ environment_name: "production", environment_id: "invalid" }]]) {
    const value = populatedSnapshot(); value.marker = marker;
    assert.throws(() => summarizeSnapshot(value), matchesCode("production_preflight_marker_mismatch"));
  }
});

test("unknown roles and malformed catalogue fields are rejected", () => {
  for (const change of [
    (value) => { value.roles = [role("unrequested_private_role")]; },
    (value) => { value.roles = [role(CANONICAL_ROLES[0]), role(CANONICAL_ROLES[0])]; },
    (value) => { value.catalogue.user_relation_count = "0"; },
    (value) => { value.catalogue.public_schema_create = "false"; },
    (value) => { value.catalogue.ledger_readable = true; },
    (value) => { value.roles = null; }
  ]) {
    const value = snapshot(); change(value);
    assert.throws(() => summarizeSnapshot(value), matchesCode("production_preflight_catalogue_invalid"));
  }
});

test("read-only transaction queries only fixed catalogue statements and always rolls back", async () => {
  const client = fakeClient();
  const report = await inspectConnectedClient(client, "fixture_operator");
  assert.equal(report.baselineCandidate, true);
  assert.deepEqual(client.transcript.map((entry) => entry.text), [SQL.begin, SQL.identity, SQL.catalogue, SQL.roles, SQL.rollback]);
  assert.deepEqual(client.transcript[1].parameters, ["fixture_operator"]);
  assert.deepEqual(client.transcript[3].parameters, [CANONICAL_ROLES]);
  assert.doesNotMatch(JSON.stringify(report), /fixture_operator|fixture-only/);
  for (const statement of Object.values(SQL)) assert.doesNotMatch(statement.replace(/'(?:[^']|'')*'/g, "''"), /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COMMIT|COPY|CALL)\b/i);
});

test("wrong target, principal, version, TLS or transaction stops before catalogue reads", async () => {
  const cases = [
    ["database_name", "ia4tube_social_staging", "target_mismatch"],
    ["principal_matches", false, "target_mismatch"],
    ["server_version_num", 170008, "postgres_18_required"],
    ["server_version_num", "180004", "postgres_18_required"],
    ["transaction_read_only", "off", "read_only_required"],
    ["transaction_isolation", "read committed", "read_only_required"],
    ["ssl_in_use", false, "tls_required"]
  ];
  for (const [field, actual, suffix] of cases) {
    const value = snapshot(); value.identity[field] = actual;
    const client = fakeClient(value);
    await assert.rejects(inspectConnectedClient(client, "fixture_operator"), matchesCode(`production_preflight_${suffix}`));
    assert.deepEqual(client.transcript.map((entry) => entry.text), [SQL.begin, SQL.identity, SQL.rollback]);
  }
});

test("only existing readable ordinary metadata tables are read, and absent privilege is a blocker", async () => {
  const value = populatedSnapshot();
  value.catalogue.ledger_readable = false;
  value.catalogue.marker_readable = false;
  const client = fakeClient(value);
  const report = await inspectConnectedClient(client, "fixture_operator");
  assert.equal(report.ledgerChecksumsVerified, false);
  assert.equal(report.pendingMigrations, null);
  assert.ok(report.blockers.includes("migration_ledger_read_with_authorized_principal_required"));
  assert.ok(report.blockers.includes("environment_marker_read_with_authorized_principal_required"));
  assert.ok(!client.transcript.some((entry) => entry.text === SQL.ledger || entry.text === SQL.marker));
});

test("existing metadata tables are read with a bounded row limit then rolled back", async () => {
  const client = fakeClient(populatedSnapshot());
  const report = await inspectConnectedClient(client, "fixture_operator");
  assert.equal(report.ledgerChecksumsVerified, true);
  assert.deepEqual(client.transcript.map((entry) => entry.text), [SQL.begin, SQL.identity, SQL.catalogue, SQL.roles, SQL.ledger, SQL.marker, SQL.rollback]);
});

test("query failure rolls back and sanitizes raw database diagnostics", async () => {
  const client = fakeClient(snapshot(), SQL.catalogue);
  await assert.rejects(inspectConnectedClient(client, "fixture_operator"), matchesCode("production_preflight_query_failed"));
  assert.equal(client.transcript.at(-1).text, SQL.rollback);
  const safe = safeFailure(new Error(`private diagnostic ${url()}`));
  assert.equal(safe.code, "production_preflight_query_failed");
  assert.doesNotMatch(JSON.stringify(safe), /fixture-only|postgresql|fixture_operator/);
});

test("unconfirmed rollback is an explicit failure, not a successful inspection", async () => {
  const client = fakeClient(snapshot(), SQL.roles, true);
  await assert.rejects(inspectConnectedClient(client, "fixture_operator"), matchesCode("production_preflight_cleanup_unconfirmed"));
});

function lifecycleClient(emitAt) {
  const client = new EventEmitter();
  const fixture = fakeClient();
  client.transcript = fixture.transcript;
  client.ended = false;
  client.connect = async () => { if (emitAt === "connect") client.emit("error", new Error(url())); };
  client.end = async () => { client.ended = true; if (emitAt === "end") client.emit("error", new Error(url())); };
  client.query = async (...args) => {
    const result = await fixture.query(...args);
    if (args[0] === emitAt) client.emit("error", new Error(url()));
    return result;
  };
  return client;
}

test("idle pg error events are sanitized and prevent a successful report", async () => {
  for (const at of ["connect", SQL.catalogue, SQL.rollback, "end"]) {
    const client = lifecycleClient(at);
    await assert.rejects(inspectClientLifecycle(client, "fixture_operator"), matchesCode(
      at === "connect" ? "production_preflight_connection_failed" : "production_preflight_query_failed"
    ));
    assert.equal(client.ended, true);
    if (at === SQL.catalogue) assert.equal(client.transcript.at(-1).text, SQL.rollback);
  }
});

test("a healthy synthetic lifecycle returns a sanitized report only after closing its client", async () => {
  const client = lifecycleClient(null);
  const result = await inspectClientLifecycle(client, "fixture_operator");
  assert.equal(client.ended, true);
  assert.equal(result.ok, true);
});
