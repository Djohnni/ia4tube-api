"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { fixtureContext } = require("./helpers/publication-atomic-memory-pool");
const { createTenantMemoryPool } = require("./helpers/production-tenant-memory-pool");
const { createProductionTenantRepository, ENSURE_OFFICIAL_OWNER_SQL } = require("../src/persistence/postgres/production-tenant-repository");
const { officialOwnerBinding, ProductionTenantBindingError } = require("../src/social/production-tenant-binding");
const { createProductionTenantProvisioning, PROVISIONING_TIMEOUT_MS } = require("../src/social/production-tenant-provisioning");

function fixture() {
  const identity = fixtureContext("synthetic-binding-owner");
  const principal = identity.adapter.fromVerifiedJwt(identity.claims);
  const pool = createTenantMemoryPool();
  const tenants = createProductionTenantRepository({ pool, identityDerivationVersion: "v1" });
  const clients = { [identity.claims.sub]: { ativo: true } }, logs = [];
  const hook = createProductionTenantProvisioning({ enabled: true, readClients: () => clients,
    getDependencies: () => ({ authAdapter: identity.adapter, tenants }), logger: { warn: entry => logs.push(entry) } });
  return { ...identity, principal, pool, tenants, clients, logs, hook };
}
function manualTimers() {
  const callbacks = new Map(); let sequence = 0;
  return { setTimeout(callback, milliseconds) { assert.equal(milliseconds, PROVISIONING_TIMEOUT_MS); const id = ++sequence; callbacks.set(id, callback); return id; },
    clearTimeout(id) { callbacks.delete(id); }, fire() { const entries = [...callbacks.values()]; callbacks.clear(); for (const callback of entries) callback(); } };
}
async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve(); }

test("binding derives only opaque fixed-domain data from a branded official JWT principal", () => {
  const f = fixture(), binding = officialOwnerBinding(f.principal, "v1");
  assert.equal(binding.companyId, f.context.companyId); assert.equal(binding.userId, f.context.userId);
  const expected = crypto.createHash("sha256").update(`ia4tube-social-official-owner-v1\n${binding.companyId}\n${binding.userId}\nv1`).digest("hex");
  assert.equal(binding.loginKeyDigest, expected); assert.ok(Object.isFrozen(binding));
  assert.ok(!JSON.stringify(binding).includes(f.claims.sub));
  assert.throws(() => officialOwnerBinding({ ...f.principal }, "v1"), e => e.code === "social_session_login_required");
  assert.throws(() => officialOwnerBinding(f.principal, "v2"), e => e.code === "social_tenant_binding_conflict");
});
test("repository supplies both transaction scopes and calls only the three-parameter function", async () => {
  const f = fixture(), result = await f.tenants.ensureOfficialOwner(f.principal);
  assert.equal(result.created, true); assert.ok(Object.isFrozen(result));
  const calls = f.pool.statements.filter(row => row.sql === ENSURE_OFFICIAL_OWNER_SQL);
  assert.deepEqual(calls[0].parameters, [f.context.companyId, f.context.userId, "v1"]);
  assert.equal(f.pool.statements[0].sql, "BEGIN"); assert.equal(f.pool.statements.at(-1).sql, "COMMIT");
  assert.ok(f.pool.statements.some(row => row.sql.includes("ia4tube.user_id")));
  assert.ok(!JSON.stringify(f.pool.statements).includes(f.claims.sub));
  assert.ok(f.pool.statements.every(row => !/\b(INSERT|UPDATE|DELETE|GRANT|CREATE)\b/.test(row.sql)));
});
test("protocol replay, concurrency and two company identities never redirect the SQL parameters", async () => {
  const f = fixture(), other = fixtureContext("synthetic-second-binding-owner");
  const rows = await Promise.all([f.tenants.ensureOfficialOwner(f.principal), f.tenants.ensureOfficialOwner(f.principal),
    f.tenants.ensureOfficialOwner(other.adapter.fromVerifiedJwt(other.claims))]);
  assert.equal(rows.filter(row => row.created).length, 2); assert.equal(f.pool.tenants.size, 2);
  assert.notEqual(rows[0].companyId, rows[2].companyId);
});
test("unbranded or conflicting-version principal is rejected before acquiring a connection", async () => {
  const f = fixture();
  await assert.rejects(f.tenants.ensureOfficialOwner({ ...f.principal }), e => e.code === "social_session_login_required");
  assert.equal(f.pool.statements.length, 0);
});
for (const code of ["PTB01", "42883", "42501", "57014", "08006"]) test(`SQL failure ${code} rolls back and exposes only a fixed safe code`, async () => {
  const f = fixture(); f.pool.setFailure(Object.assign(new Error("SYNTHETIC_PRIVATE_DETAIL"), { code, detail: "SYNTHETIC_PRIVATE_DETAIL" }));
  await assert.rejects(f.tenants.ensureOfficialOwner(f.principal), e =>
    e.code === (code === "PTB01" ? "social_tenant_binding_conflict" : "social_tenant_provisioning_unavailable") &&
    !JSON.stringify(e).includes("SYNTHETIC_PRIVATE_DETAIL") && !e.cause);
  assert.equal(f.pool.statements.at(-1).sql, "ROLLBACK"); assert.equal(f.pool.tenants.size, 0);
});
for (const mutation of [row => ({ ...row, company_id: crypto.randomUUID() }), row => ({ ...row, role: "member" }),
  row => ({ ...row, auth_version: "9007199254740992" }), row => ({ ...row, created: "true" })]) {
  test("foreign or malformed function result fails closed and rolls back", async () => {
    const f = fixture(); f.pool.mutateResponse(mutation);
    await assert.rejects(f.tenants.ensureOfficialOwner(f.principal), e => e.code === "social_tenant_provisioning_unavailable");
    assert.equal(f.pool.statements.at(-1).sql, "ROLLBACK"); assert.equal(f.pool.tenants.size, 0);
  });
}
test("disabled hook consumes no owner, product store, runtime, logger or timers", async () => {
  const options = { enabled: false };
  for (const key of ["readClients", "getDependencies", "logger", "setTimeout"]) Object.defineProperty(options, key, { get() { assert.fail("disabled dependency consumed"); } });
  const hook = createProductionTenantProvisioning(options);
  assert.equal((await hook.afterAuthentication(new Proxy({}, { get() { assert.fail(); } }))).code, "social_persistence_disabled");
});
for (const active of [undefined, null, false, 0, "true"]) test(`non-explicit active owner (${String(active)}) is not provisioned`, async () => {
  const f = fixture(); f.clients[f.claims.sub].ativo = active;
  assert.equal((await f.hook.afterAuthentication(f.claims.sub)).code, "social_tenant_owner_unavailable");
  assert.equal(f.pool.statements.length, 0);
});
test("temporary automatic identity is never provisioned; final identity is derived independently", async () => {
  const f = fixture(); f.clients[f.claims.sub].cadastro_automatico = true;
  assert.equal((await f.hook.afterAuthentication(f.claims.sub)).code, "social_tenant_owner_temporary");
  assert.equal(f.pool.statements.length, 0);
  f.clients["synthetic-final-owner"] = { ativo: true, cadastro_automatico: true, conta_finalizada: true };
  assert.equal((await f.hook.afterAuthentication("synthetic-final-owner")).available, true);
  assert.ok(!f.pool.tenants.has(f.context.companyId));
});
test("hook succeeds idempotently; social errors and failing logger never break completed product authentication", async () => {
  const f = fixture(); assert.equal((await f.hook.afterAuthentication(f.claims.sub)).available, true);
  assert.equal((await f.hook.afterAuthentication(f.claims.sub)).available, true); assert.equal(f.pool.tenants.size, 1);
  f.pool.setFailure(Object.assign(new Error("SYNTHETIC_PRIVATE_DETAIL"), { code: "PTB01" }));
  assert.equal((await f.hook.afterAuthentication(f.claims.sub)).code, "social_tenant_binding_conflict");
  assert.ok(f.logs.every(row => Object.keys(row).sort().join() === "code,component"));
  assert.ok(!JSON.stringify(f.logs).includes(f.claims.sub));
  const hook = createProductionTenantProvisioning({ enabled: true, readClients() { throw new Error("private"); },
    getDependencies() { assert.fail(); }, logger: { warn() { throw new Error("private"); } } });
  assert.equal((await hook.afterAuthentication(f.claims.sub)).available, false);
});
test("deadline retains and deduplicates the exact pending writer until late settlement", async () => {
  const f = fixture(), timers = manualTimers(); let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const hook = createProductionTenantProvisioning({ enabled: true, readClients: () => f.clients, ...timers,
    getDependencies: () => ({ authAdapter: f.adapter, tenants: { async ensureOfficialOwner(principal) { calls++; await gate; return f.tenants.ensureOfficialOwner(principal); } } }) });
  const first = hook.afterAuthentication(f.claims.sub); await flush(); timers.fire();
  assert.equal((await first).code, "social_tenant_provisioning_timeout"); assert.equal(hook.status().inFlightCount, 1);
  const second = hook.afterAuthentication(f.claims.sub); await flush(); assert.equal(calls, 1);
  release(); assert.equal((await second).available, true); assert.equal(hook.status().inFlightCount, 0);
  assert.equal(f.pool.tenants.size, 1); assert.equal((await hook.close()).settled, true);
});
test("at most three distinct in-flight writers; bounded close preserves accounting and forbids new work", async () => {
  const f = fixture(), timers = manualTimers(); let rejectPending;
  const pending = new Promise((_, reject) => { rejectPending = reject; }); let calls = 0;
  const hook = createProductionTenantProvisioning({ enabled: true, readClients: () => f.clients, ...timers,
    getDependencies: () => ({ authAdapter: f.adapter, tenants: { async ensureOfficialOwner() { calls++; return pending; } } }) });
  const waits = [];
  for (let n = 0; n < 3; n++) { const owner = `synthetic-parallel-${n}`; f.clients[owner] = { ativo: true }; waits.push(hook.afterAuthentication(owner)); }
  await flush(); f.clients["synthetic-fourth"] = { ativo: true };
  assert.equal((await hook.afterAuthentication("synthetic-fourth")).code, "social_tenant_provisioning_busy"); assert.equal(calls, 3);
  timers.fire(); await Promise.all(waits);
  const closing = hook.close(); await flush(); timers.fire();
  assert.deepEqual(await closing, { settled: false, inFlightCount: 3 });
  assert.equal((await hook.afterAuthentication("synthetic-fourth")).available, false); assert.equal(calls, 3);
  rejectPending(new ProductionTenantBindingError("social_tenant_binding_conflict")); await flush();
  assert.equal(hook.status().inFlightCount, 0);
});
