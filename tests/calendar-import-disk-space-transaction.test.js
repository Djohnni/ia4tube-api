"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createPostgresGlobalCapacityStore, isPostgresGlobalCapacityStore } = require("../src/social/calendar/imports/postgres-global-capacity-store");
const { createGlobalMediaCapacity, freshGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const { createDiskSpaceGuard, createDiskSpaceGuardForTests, assertDiskSpaceEvidence } = require("../src/social/calendar/imports/disk-space-guard");
const context = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(patch = {}) { return { context, jobId: crypto.randomUUID(), companyId: crypto.randomUUID(), userId: crypto.randomUUID(),
  requestDigest: "a".repeat(64), storageBytes: 100, sourceBytes: 40, ...patch }; }
function database({ schema = {}, beforeConnect = async () => {}, afterLock = async () => {} } = {}) {
  const calls = []; let current = freshGlobalCapacityState(), connectCount = 0;
  const good = { principal: "ia4tube_media_capacity_runtime", owner: "ia4tube_social_owner", rls: true, forced: true,
    policies: 1, scope_using: "(singleton = 1)", scope_check: "(singleton = 1)", policy_role_exact: true,
    unsafe_principal: false, session_owns_table: false, public_table_access: false, public_schema_access: false,
    custom_trigger: false, creatable: false, readable: true, document_mutable: true, key_mutable: false,
    insertable: false, deletable: false, truncatable: false, tenant_access: false, tenant_data_access: false, ...schema };
  const pool = { async connect() {
    connectCount++; await beforeConnect(); let pending = null;
    return { async query(sql, params) {
      calls.push(sql);
      if (sql.includes("current_user AS principal")) return { rows: [good] };
      if (sql.startsWith("SELECT document")) { await afterLock(); return { rows: [{ document: structuredClone(current) }] }; }
      if (sql.startsWith("UPDATE")) pending = JSON.parse(params[0]);
      if (sql === "COMMIT" && pending) current = pending;
      return { rows: [], rowCount: 1 };
    }, release() {} };
  } };
  return { store: createPostgresGlobalCapacityStore({ pool }), calls, connects: () => connectCount, snapshot: () => structuredClone(current) };
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ia4tube-capacity-evidence-unit-")); await fs.chmod(root, 0o700);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ia4tube-capacity-evidence-unit-"));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(root, { recursive: true, force: true });
  });
  const db = database(options), guard = createDiskSpaceGuard({ rootDirectory: root, enabled: true, marginBytes: 0 });
  const api = createGlobalMediaCapacity({ store: db.store, enabled: true, requireDiskSpaceEvidence: true, diskSpaceGuard: guard });
  return { ...db, root, guard, api };
}

test("only the official branded store can refresh a production guard; callbacks remain synchronous", async t => {
  const f = await fixture(t);
  assert.equal(isPostgresGlobalCapacityStore(f.store), true);
  assert.equal(isPostgresGlobalCapacityStore({ ...f.store }), false);
  assert.equal(f.store.capabilities.transactionalDiskSpaceEvidence, true);
  await assert.rejects(f.store.updateWithDiskSpaceEvidence(async () => true, f.guard), { code: "media_capacity_async_transaction_forbidden" });
  await assert.rejects(f.store.updateWithDiskSpaceEvidence(() => true, { ...f.guard }), { code: "media_capacity_disk_space_guard_invalid" });
  const fakeGuard = createDiskSpaceGuardForTests({ rootDirectory: f.root, enabled: true, statfsForTests: async () => ({ bavail: 1000n, bsize: 1n }) });
  await assert.rejects(f.store.updateWithDiskSpaceEvidence(() => true, fakeGuard), { code: "media_capacity_disk_space_guard_invalid" });
  assert.equal(f.connects(), 0);
  await assert.rejects(f.store.updateWithDiskSpaceEvidence(state => { state.paused = true; return Promise.resolve(true); }, f.guard),
    { code: "media_capacity_async_transaction_forbidden" });
  assert.equal(f.snapshot().paused, false); assert.equal(f.calls.at(-1), "ROLLBACK");
  assert.equal(f.calls.some(sql => sql.startsWith("UPDATE")), false);
});

test("original forged, wrong-issuer and expired evidence is refused before acquiring any database connection", async t => {
  const f = await fixture(t), other = createDiskSpaceGuard({ rootDirectory: f.root, enabled: true, marginBytes: 0 });
  const expired = await f.guard.sample(); await delay(1100);
  for (const diskSpaceEvidence of [{}, structuredClone(await f.guard.sample()), await other.sample(), expired]) {
    await assert.rejects(f.api.reserveStorage(request({ diskSpaceEvidence })), { code: "media_capacity_disk_space_evidence_invalid" });
    await assert.rejects(f.api.assertHeld(request({ diskSpaceEvidence })), { code: "media_capacity_disk_space_evidence_invalid" });
  }
  assert.equal(f.connects(), 0); assert.deepEqual(f.snapshot(), freshGlobalCapacityState());
});

test("new evidence follows the lock and remains fresh after a cold wait longer than one second", async t => {
  let wait = true;
  const f = await fixture(t, { beforeConnect: async () => { if (wait) { wait = false; await delay(1100); } } });
  const original = await f.guard.sample(), row = request({ diskSpaceEvidence: original });
  const received = await f.api.reserveStorage(row);
  assert.equal(received.storageHeld, true);
  assert.throws(() => assertDiskSpaceEvidence(original, { guard: f.guard }), { code: "disk_space_evidence_stale" });
  assert.equal(f.calls[0], "BEGIN"); assert.equal(f.calls[1], 'SET LOCAL ROLE "ia4tube_media_capacity_runtime"');
  assert.match(f.calls[2], /current_user AS principal/); assert.match(f.calls[3], /FOR UPDATE$/);
  assert.equal(f.calls.at(-1), "COMMIT");
  const before = f.snapshot();
  const repeated = await f.api.reserveStorage({ ...row, diskSpaceEvidence: await f.guard.sample() });
  assert.equal(repeated.jobId, received.jobId); assert.deepEqual(f.snapshot(), before);
});

test("a copied store cannot select refresh by claiming the capability; legacy transaction-time expiry still applies", async t => {
  let refreshCalled = false;
  const f = await fixture(t, { beforeConnect: () => delay(1100) });
  const copied = { ...f.store, updateWithDiskSpaceEvidence() { refreshCalled = true; throw new Error("untrusted hook"); } };
  const api = createGlobalMediaCapacity({ store: copied, enabled: true, requireDiskSpaceEvidence: true, diskSpaceGuard: f.guard });
  await assert.rejects(api.reserveStorage(request({ diskSpaceEvidence: await f.guard.sample() })), { code: "media_capacity_disk_space_evidence_invalid" });
  assert.equal(refreshCalled, false); assert.deepEqual(f.snapshot(), freshGlobalCapacityState());
});

test("space falling while waiting for the lock is reobserved and rolls back; reads still do not require evidence", async t => {
  // Patch only the OS observation in this sequential unit test. The actual
  // branded production guard, root verification and transaction code remain.
  const nativeStatfs = fs.statfs; let freeBytes = 1000n, reduceOnLock = false, samples = 0;
  try {
    const f = await fixture(t, { afterLock: async () => { if (reduceOnLock) freeBytes = 0n; } });
    fs.statfs = async (...args) => { if (args[0] !== f.root) return nativeStatfs(...args); samples++; return { bavail: freeBytes, bsize: 1n }; };
    const row = request({ diskSpaceEvidence: await f.guard.sample() });
    await f.api.reserveStorage(row); const held = f.snapshot();
    const tokenBeforeFall = await f.guard.sample(); reduceOnLock = true;
    await assert.rejects(f.api.reserveStorage(request({ diskSpaceEvidence: tokenBeforeFall })), { code: "media_capacity_disk_space_insufficient" });
    assert.deepEqual(f.snapshot(), held); assert.equal(f.calls.at(-1), "ROLLBACK");
    freeBytes = 1000n;
    await assert.rejects(f.api.assertHeld({ ...row, diskSpaceEvidence: await f.guard.sample() }), { code: "media_capacity_disk_space_insufficient" });
    assert.deepEqual(f.snapshot(), held);
    const beforeRead = samples;
    assert.equal((await f.api.assertHeld({ ...row, intent: "read", diskSpaceEvidence: undefined })).storageHeld, true);
    assert.equal(samples, beforeRead);
  } finally { fs.statfs = nativeStatfs; }
});

test("fresh evidence does not change schema, tenant, quota, idempotency or paused-ledger checks", async t => {
  const f = await fixture(t), row = request({ diskSpaceEvidence: await f.guard.sample() });
  const api = createGlobalMediaCapacity({ store: f.store, enabled: true, requireDiskSpaceEvidence: true, diskSpaceGuard: f.guard,
    limits: { globalStorageBytes: 100, companyStorageBytes: 100 } });
  await api.reserveStorage(row); const before = f.snapshot();
  await assert.rejects(api.reserveStorage({ ...row, userId: crypto.randomUUID(), diskSpaceEvidence: await f.guard.sample() }), { code: "media_capacity_reservation_conflict" });
  await assert.rejects(api.reserveStorage(request({ diskSpaceEvidence: await f.guard.sample() })), { code: "media_capacity_storage_exceeded" });
  assert.deepEqual(f.snapshot(), before);
  await f.store.update(state => { state.paused = true; });
  await assert.rejects(api.reserveStorage(request({ diskSpaceEvidence: await f.guard.sample() })), { code: "media_capacity_paused" });
  const unsafe = database({ schema: { forced: false } });
  let invoked = false;
  await assert.rejects(unsafe.store.updateWithDiskSpaceEvidence(() => { invoked = true; }, f.guard), { code: "media_capacity_schema_not_ready" });
  assert.equal(invoked, false); assert.equal(unsafe.calls.some(sql => sql.includes("SELECT document")), false);
});
