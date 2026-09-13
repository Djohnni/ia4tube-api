"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createTransferAuthorizationRegistry, createMemoryTransferRegistryStore, validateTransferRegistryState,
  freshTransferRegistryState } = require("../src/social/calendar/imports/transfer-registry");
const time = 1800000000000;
function binding(patch = {}) { return { authorizationId: crypto.randomUUID(), companyId: crypto.randomUUID(), userId: crypto.randomUUID(),
  assetId: crypto.randomUUID(), objectKey: "a".repeat(64), providerUploadId: crypto.randomUUID(), partNumber: 1, sizeBytes: 12,
  sha256: "b".repeat(64), md5Base64: Buffer.alloc(16, 2).toString("base64"), expiresAt: time + 600000, ...patch }; }
function fixture(options = {}) {
  const store = createMemoryTransferRegistryStore();
  return { store, registry: createTransferAuthorizationRegistry({ store, enabled: true, allowVolatileForTests: true, clock: () => time, ...options }) };
}

test("transfer registry is disabled by default and volatile storage requires explicit test opt-in", async () => {
  const store = createMemoryTransferRegistryStore();
  for (const registry of [createTransferAuthorizationRegistry({ store }), createTransferAuthorizationRegistry({ store, enabled: true }),
    createTransferAuthorizationRegistry({ enabled: true, allowVolatileForTests: true })]) {
    assert.equal(registry.capabilities.available, false);
    await assert.rejects(registry.register(binding()), { code: "media_transfer_registry_disabled" });
    await assert.rejects(registry.resolve(crypto.randomUUID()), { code: "media_transfer_registry_disabled" });
    await assert.rejects(registry.verify(), { code: "media_transfer_registry_disabled" });
  }
  assert.equal(await fixture().registry.verify(), true);
});
test("exact opaque UUID lookup crosses no supplied company scope, hashes storage and survives registry recreation", async () => {
  const { store, registry } = fixture(), a = binding(), b = binding();
  assert.deepEqual(await registry.register(a), a); await registry.register(b);
  const rawState = await store.update(state => state), serialized = JSON.stringify(rawState);
  assert.equal(serialized.includes(a.authorizationId), false); assert.equal(serialized.includes(b.authorizationId), false);
  assert.ok(Object.keys(rawState.grants).every(key => /^[a-f0-9]{64}$/.test(key)));
  const recreated = createTransferAuthorizationRegistry({ store, enabled: true, allowVolatileForTests: true, clock: () => time });
  const resolved = await recreated.resolve(a.authorizationId); assert.deepEqual(resolved, a);
  resolved.companyId = b.companyId;
  assert.deepEqual(await registry.resolve(a.authorizationId), a);
  assert.equal(await registry.resolve(crypto.randomUUID()), null);
  await assert.rejects(registry.resolve({ authorizationId: a.authorizationId, companyId: b.companyId }), { code: "media_transfer_authorization_invalid" });
});
test("binding is immutable for every field and replay is idempotent", async () => {
  const { registry } = fixture(), initial = binding(); await registry.register(initial);
  for (const [field, value] of Object.entries({ companyId: crypto.randomUUID(), userId: crypto.randomUUID(), assetId: crypto.randomUUID(),
    objectKey: "c".repeat(64), providerUploadId: crypto.randomUUID(), partNumber: 2, sizeBytes: 13,
    sha256: "d".repeat(64), md5Base64: Buffer.alloc(16, 3).toString("base64"), expiresAt: time + 599999 })) {
    await assert.rejects(registry.register({ ...initial, [field]: value }), { code: "media_transfer_authorization_conflict" });
  }
  assert.deepEqual(await registry.register(initial), initial);
  assert.deepEqual(await registry.resolve(initial.authorizationId), initial);
});
test("canonical UUID, exact fields, checksum, chunk and ten-minute expiry are checked before storage", async () => {
  const { registry, store } = fixture();
  for (const patch of [{ authorizationId: "../../tenant/secret" }, { authorizationId: crypto.randomUUID().toUpperCase() },
    { authorizationId: "00000000-0000-1000-8000-000000000000" }, { sizeBytes: 0 }, { sizeBytes: 5 * 1024 * 1024 + 1 },
    { partNumber: 21 }, { partNumber: 1.5 }, { companyId: "company" }, { providerUploadId: "opaque/provider/path" },
    { objectKey: "private/object/url" }, { sha256: "not-a-hash" }, { md5Base64: "short" },
    { expiresAt: time }, { expiresAt: time + 600001 }, { expiresAt: Infinity }, { url: "https://synthetic.invalid" }]) {
    await assert.rejects(registry.register(binding(patch)), error => /^media_transfer_/.test(error.code));
  }
  const missing = binding(); delete missing.userId;
  await assert.rejects(registry.register(missing), { code: "media_transfer_binding_invalid" });
  assert.equal(Object.keys((await store.update(state => state)).grants).length, 0);
});
test("atomic global admission is bounded across registries, and expiry removes only grant metadata", async () => {
  let clock = time;
  const { registry, store } = fixture({ maxActiveRecords: 2, clock: () => clock });
  const second = createTransferAuthorizationRegistry({ store, enabled: true, allowVolatileForTests: true, maxActiveRecords: 2, clock: () => clock });
  const rows = Array.from({ length: 20 }, () => binding({ expiresAt: time + 5 }));
  const results = await Promise.allSettled(rows.map((row, i) => (i % 2 ? second : registry).register(row)));
  assert.equal(results.filter(item => item.status === "fulfilled").length, 2);
  assert.ok(results.filter(item => item.status === "rejected").every(item => item.reason.code === "media_transfer_registry_full"));
  clock += 5;
  const next = binding({ expiresAt: clock + 1000 }); await second.register(next);
  assert.equal(Object.keys((await store.update(state => state)).grants).length, 1);
  assert.equal(await registry.resolve(rows[0].authorizationId), null);
  assert.deepEqual(await registry.resolve(next.authorizationId), next);
});
test("revocation keeps an immutable tombstone until expiry and cannot be undone by register", async () => {
  let clock = time;
  const { registry, store } = fixture({ clock: () => clock }), row = binding({ expiresAt: time + 100 });
  await registry.register(row);
  assert.equal(await registry.revoke(row.authorizationId), true); assert.equal(await registry.revoke(row.authorizationId), true);
  assert.equal(await registry.resolve(row.authorizationId), null);
  await assert.rejects(registry.register(row), { code: "media_transfer_authorization_revoked" });
  assert.equal(Object.keys((await store.update(state => state)).grants).length, 1);
  assert.equal(await registry.revoke(crypto.randomUUID()), false);
  clock += 100;
  assert.equal(await registry.resolve(row.authorizationId), null);
  assert.equal(Object.keys((await store.update(state => state)).grants).length, 0);
});
test("state validation rejects raw grants, foreign payload, corruption and oversized grant maps", () => {
  const hash = "f".repeat(64), row = binding(), { authorizationId, ...safeBinding } = row;
  const valid = { schema: 1, grants: { [hash]: { binding: safeBinding, revoked: false } } };
  assert.equal(validateTransferRegistryState(valid), valid);
  for (const state of [{ ...freshTransferRegistryState(), idempotency: {} }, { schema: 1, grants: { [authorizationId]: valid.grants[hash] } },
    { schema: 1, grants: { [hash]: { binding: row, revoked: false } } },
    { schema: 1, grants: { [hash]: { binding: safeBinding, revoked: "false" } } },
    { schema: 1, grants: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [i.toString(16).padStart(64, "0"), valid.grants[hash]])) }]) {
    assert.throws(() => validateTransferRegistryState(state), { code: "media_transfer_state_invalid" });
  }
});
test("store failures expose no raw grant, connection detail or forged error text; callbacks cannot be async", async () => {
  const store = createMemoryTransferRegistryStore();
  await assert.rejects(store.update(async state => { state.schema = 2; }), { code: "media_transfer_async_transaction_forbidden" });
  await assert.rejects(store.update(state => { state.schema = 2; }), { code: "media_transfer_state_invalid" });
  assert.deepEqual(await store.update(state => state), freshTransferRegistryState());
  const leaked = "secret raw bearer database password";
  const registry = createTransferAuthorizationRegistry({ enabled: true, store: { capabilities: { persistence: "durable", atomicGrantUpdates: true,
    boundedRegistryLedger: true }, verify: async () => true, update: async () => { throw Object.assign(new Error(leaked), { code: "media_transfer_forged" }); } } });
  await assert.rejects(registry.resolve(crypto.randomUUID()), error => error.code === "media_transfer_storage_unavailable" && !error.message.includes(leaked) && !error.cause);
});
