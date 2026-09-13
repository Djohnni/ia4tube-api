"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createPostgresTransferRegistryStore } = require("../src/social/calendar/imports/postgres-transfer-registry-store");
const { freshTransferRegistryState } = require("../src/social/calendar/imports/transfer-registry");
function fixture({ schema = {}, commitFailure = false, missingRow = false } = {}) {
  const calls = [], releases = [];
  const good = { principal: "ia4tube_media_transfer_runtime", owner: "ia4tube_social_owner", rls: true, forced: true, policies: 1,
    scope_using: "(singleton = 1)", scope_check: "(singleton = 1)", policy_role_exact: true,
    unsafe_principal: false, unexpected_membership: false, session_owns_table: false, session_owns_database: false,
    custom_trigger: false, public_table_access: false, public_schema_access: false, unexpected_table_access: false, unexpected_column_access: false,
    creatable: false, readable: true, document_mutable: true, revision_mutable: true, timestamp_mutable: true,
    key_mutable: false, insertable: false, deletable: false, truncatable: false, foreign_registry_access: false, foreign_data_access: false, ...schema };
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("current_user AS principal")) return { rows: [good] };
    if (sql.includes("SELECT document")) return { rows: missingRow ? [] : [{ document: freshTransferRegistryState() }] };
    if (sql === "COMMIT" && commitFailure) throw Object.assign(new Error("unsafe provider token connection password"), { code: "57P01" });
    return { rows: [], rowCount: 1 };
  }, release(error) { releases.push(Boolean(error)); } };
  return { store: createPostgresTransferRegistryStore({ pool: { connect: async () => client } }), calls, releases };
}
test("registry postgres verifies fixed-role isolated forced RLS in its lock transaction and commits before resolving", async () => {
  const f = fixture();
  assert.deepEqual(await f.store.update(state => state), freshTransferRegistryState());
  assert.equal(f.calls[0].sql, "BEGIN"); assert.equal(f.calls[1].sql, 'SET LOCAL ROLE "ia4tube_media_transfer_runtime"');
  assert.match(f.calls[2].sql, /current_user AS principal/); assert.match(f.calls[3].sql, /WHERE singleton=1 FOR UPDATE$/);
  assert.equal(f.calls[4].sql, "COMMIT"); assert.deepEqual(f.releases, [false]);
  assert.equal(f.calls.some(call => call.sql.startsWith("UPDATE")), false);
});
test("registry postgres refuses every dangerous role, tenant/capacity crossing and schema privilege drift before ledger read", async () => {
  for (const schema of [{ principal: "ia4tube_social_runtime" }, { owner: "postgres" }, { policies: 2 }, { scope_using: "true" },
    { scope_check: "true" }, ...["rls", "forced", "policy_role_exact", "readable", "document_mutable", "revision_mutable", "timestamp_mutable"].map(key => ({ [key]: false })),
    ...["unsafe_principal", "unexpected_membership", "session_owns_table", "session_owns_database", "custom_trigger", "public_table_access",
      "public_schema_access", "unexpected_table_access", "unexpected_column_access", "creatable", "key_mutable", "insertable", "deletable", "truncatable",
      "foreign_registry_access", "foreign_data_access"].map(key => ({ [key]: true })), { foreign_data_access: undefined }]) {
    const f = fixture({ schema });
    await assert.rejects(f.store.update(() => true), { code: "media_transfer_schema_not_ready" });
    assert.equal(f.calls.some(call => call.sql.includes("SELECT document")), false); assert.equal(f.calls.at(-1).sql, "ROLLBACK");
  }
  assert.throws(() => createPostgresTransferRegistryStore({ pool: { connect() {} }, role: "postgres" }), { code: "media_transfer_store_configuration_invalid" });
});
test("registry postgres never replays unknown commits or passes connection secrets through its boundary", async () => {
  const f = fixture({ commitFailure: true });
  await assert.rejects(f.store.update(() => true), error => error.code === "media_transfer_storage_unavailable" && !error.message.includes("password") && !error.cause);
  assert.equal(f.calls.filter(call => call.sql === "COMMIT").length, 1); assert.deepEqual(f.releases, [true]);
});
test("registry postgres rejects absent singleton, async callbacks and corrupt state without writing", async () => {
  const missing = fixture({ missingRow: true }); await assert.rejects(missing.store.update(() => null), { code: "media_transfer_schema_not_ready" });
  const f = fixture(); await assert.rejects(f.store.update(async () => true), { code: "media_transfer_async_transaction_forbidden" });
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.store.update(state => { state.schema = 2; }), { code: "media_transfer_state_invalid" });
  assert.equal(f.calls.some(call => call.sql.startsWith("UPDATE")), false); assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});
test("candidate migration is additive with a bounded singleton, no SECURITY DEFINER and no broad runtime grants", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/calendar-migrations/0004_transfer_authorization_registry.up.sql"), "utf8");
  assert.match(sql, /FORCE ROW LEVEL SECURITY/); assert.match(sql, /singleton=1/); assert.match(sql, /<=8388608/); assert.match(sql, /<=4096/);
  assert.match(sql, /GRANT UPDATE\(document,revision,updated_at\)/); assert.doesNotMatch(sql, /SECURITY DEFINER|CREATE ROLE|CREATE FUNCTION|GRANT ALL|DROP TABLE/i);
  assert.match(sql, /NOT per-grant or tenant RLS/);
});
