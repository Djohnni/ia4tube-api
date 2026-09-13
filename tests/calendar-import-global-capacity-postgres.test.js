"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createPostgresGlobalCapacityStore } = require("../src/social/calendar/imports/postgres-global-capacity-store");
const { freshGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
function fixture({ schema = {}, commitFailure = false } = {}) {
  const calls = [], releases = [], document = freshGlobalCapacityState();
  const good = { principal: "ia4tube_media_capacity_runtime", owner: "ia4tube_social_owner", rls: true, forced: true,
    policies: 1, scope_using: "(singleton = 1)", scope_check: "(singleton = 1)", policy_role_exact: true,
    unsafe_principal: false, session_owns_table: false, public_table_access: false, public_schema_access: false,
    custom_trigger: false, creatable: false, readable: true, document_mutable: true, key_mutable: false,
    insertable: false, deletable: false, truncatable: false, tenant_access: false, tenant_data_access: false, ...schema };
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("current_user AS principal")) return { rows: [good] };
    if (sql.includes("SELECT document")) return { rows: [{ document: structuredClone(document) }] };
    if (sql === "COMMIT" && commitFailure) { const error = new Error("unsafe provider payload secret"); error.code = "57P01"; throw error; }
    return { rows: [], rowCount: 1 };
  }, release(error) { releases.push(Boolean(error)); } };
  return { store: createPostgresGlobalCapacityStore({ pool: { connect: async () => client } }), calls, releases };
}
test("global postgres store uses fixed restricted role, same-transaction schema checks, row lock and commit-before-resolution", async () => {
  const f = fixture();
  const result = await f.store.update(state => { state.paused = true; return { changed: true }; });
  assert.deepEqual(result, { changed: true });
  assert.equal(f.calls[0].sql, "BEGIN");
  assert.equal(f.calls[1].sql, 'SET LOCAL ROLE "ia4tube_media_capacity_runtime"');
  assert.match(f.calls[3].sql, /FOR UPDATE$/);
  assert.match(f.calls[4].sql, /^UPDATE/);
  assert.equal(f.calls[5].sql, "COMMIT");
  assert.deepEqual(f.releases, [false]);
});
test("global postgres store refuses tenant runtime, extra privileges, unsafe role, absent RLS and non-exact policy", async () => {
  for (const schema of [{ principal: "ia4tube_social_runtime" }, { unsafe_principal: true }, { tenant_access: true }, { tenant_data_access: true },
    { key_mutable: true }, { public_table_access: true }, { public_schema_access: true }, { session_owns_table: true },
    { creatable: true }, { custom_trigger: true }, { forced: false }, { rls: false }, { policies: 2 },
    { policy_role_exact: false }, { scope_using: "true" }, { scope_check: "true" }, { readable: false },
    { document_mutable: false }, { insertable: true }, { deletable: true }, { truncatable: true }]) {
    const f = fixture({ schema });
    await assert.rejects(f.store.update(() => true), /schema_not_ready/);
    assert.equal(f.calls.some(call => call.sql.includes("SELECT document")), false);
    assert.equal(f.calls.at(-1).sql, "ROLLBACK");
  }
});
test("failed or uncertain commit is not replayed and does not expose underlying connection data", async () => {
  const f = fixture({ commitFailure: true });
  await assert.rejects(f.store.update(state => { state.paused = true; }), error => error.code === "media_capacity_storage_unavailable" && !error.message.includes("secret"));
  assert.equal(f.calls.filter(call => call.sql.startsWith("UPDATE")).length, 1);
  assert.equal(f.calls.filter(call => call.sql === "COMMIT").length, 1);
  assert.deepEqual(f.releases, [true]);
});
test("async transaction callback and malformed mutation cannot reach UPDATE", async () => {
  const f = fixture(); await assert.rejects(f.store.update(async () => true), /async_transaction_forbidden/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.store.update(state => { state.sequence = -1; }), /state_invalid/);
  assert.equal(f.calls.some(call => call.sql.startsWith("UPDATE")), false);
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});
