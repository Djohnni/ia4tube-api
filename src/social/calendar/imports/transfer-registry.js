"use strict";

const crypto = require("node:crypto");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const GRANT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ACTIVE_RECORDS = 4096, MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;
const BINDING_FIELDS = ["companyId", "userId", "assetId", "objectKey", "providerUploadId", "partNumber", "sizeBytes", "sha256", "md5Base64", "expiresAt"];

class TransferRegistryError extends Error {
  constructor(code, statusCode = 503) { super(`media_transfer_${code}`); this.code = this.message; this.statusCode = statusCode; }
}
function fail(code, statusCode) { throw new TransferRegistryError(code, statusCode); }
function object(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))); }
function exactFields(value, names) {
  return object(value) && Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function canonicalBinding(value) {
  if (!exactFields(value, BINDING_FIELDS) || !["companyId", "userId", "assetId", "providerUploadId"].every(key => typeof value[key] === "string" && UUID.test(value[key])) ||
      typeof value.objectKey !== "string" || !HASH.test(value.objectKey) || typeof value.sha256 !== "string" || !HASH.test(value.sha256) ||
      !Number.isSafeInteger(value.partNumber) || value.partNumber < 1 || value.partNumber > 20 ||
      !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 5 * 1024 * 1024 ||
      typeof value.md5Base64 !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(value.md5Base64) ||
      Buffer.from(value.md5Base64, "base64").toString("base64") !== value.md5Base64 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) fail("binding_invalid", 400);
  return Object.fromEntries(BINDING_FIELDS.map(key => [key, value[key]]));
}
function authorizationHash(authorizationId) {
  if (typeof authorizationId !== "string" || !GRANT_UUID.test(authorizationId)) fail("authorization_invalid", 400);
  return crypto.createHash("sha256").update(authorizationId, "ascii").digest("hex");
}
function freshTransferRegistryState() { return { schema: 1, grants: {} }; }
function validateTransferRegistryState(state) {
  try {
    if (!exactFields(state, ["schema", "grants"]) || state.schema !== 1 || !object(state.grants) ||
        Object.keys(state.grants).length > MAX_ACTIVE_RECORDS || Reflect.ownKeys(state.grants).length !== Object.keys(state.grants).length ||
        Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_DOCUMENT_BYTES) fail("state_invalid");
    for (const [hash, entry] of Object.entries(state.grants)) {
      if (!HASH.test(hash) || !exactFields(entry, ["binding", "revoked"]) || typeof entry.revoked !== "boolean") fail("state_invalid");
      canonicalBinding(entry.binding);
    }
    return state;
  } catch (_) { fail("state_invalid"); }
}
function createMemoryTransferRegistryStore() {
  let current = freshTransferRegistryState(), tail = Promise.resolve();
  return Object.freeze({
    capabilities: Object.freeze({ persistence: "volatile-test", atomicGrantUpdates: true, boundedRegistryLedger: true }),
    async verify() { validateTransferRegistryState(current); return true; },
    async update(operation) {
      if (typeof operation !== "function" || operation.constructor?.name === "AsyncFunction") fail("async_transaction_forbidden");
      const pending = tail.then(() => {
        const draft = structuredClone(current), result = operation(draft);
        if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); fail("async_transaction_forbidden"); }
        validateTransferRegistryState(draft);
        const output = structuredClone(result);
        current = draft;
        return output;
      });
      tail = pending.catch(() => {});
      return pending;
    }
  });
}
function createTransferAuthorizationRegistry({ store, enabled = false, allowVolatileForTests = false,
  maxActiveRecords = MAX_ACTIVE_RECORDS, clock = Date.now } = {}) {
  if (!Number.isSafeInteger(maxActiveRecords) || maxActiveRecords < 1 || maxActiveRecords > MAX_ACTIVE_RECORDS || typeof clock !== "function") fail("configuration_invalid");
  const persistence = store?.capabilities?.persistence;
  const durable = persistence === "durable";
  const available = Boolean(enabled && store?.capabilities?.atomicGrantUpdates === true &&
    store?.capabilities?.boundedRegistryLedger === true && typeof store?.update === "function" && typeof store?.verify === "function" &&
    (durable || allowVolatileForTests && persistence === "volatile-test"));
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail("clock_invalid"); return value; }
  async function safe(operation) {
    if (!available) fail("registry_disabled");
    try { return await operation(); }
    catch (error) { if (error instanceof TransferRegistryError) throw error; fail("storage_unavailable"); }
  }
  return Object.freeze({
    capabilities: Object.freeze({ persistence: durable ? "durable" : "volatile-test", available,
      testOnly: !durable, opaqueAuthorizationLookup: true, atomicGrantUpdates: true,
      boundedRegistryLedger: true, maxActiveRecords, maxAuthorizationLifetimeMs: MAX_AUTHORIZATION_LIFETIME_MS }),
    async verify() { return safe(async () => { if (await store.verify() !== true) fail("schema_not_ready"); return true; }); },
    async register(input) { return safe(async () => {
      if (!exactFields(input, ["authorizationId", ...BINDING_FIELDS])) fail("binding_invalid", 400);
      const authorizationId = input.authorizationId, hash = authorizationHash(authorizationId);
      const binding = canonicalBinding(Object.fromEntries(BINDING_FIELDS.map(key => [key, input[key]])));
      const time = now();
      if (binding.expiresAt <= time || binding.expiresAt - time > MAX_AUTHORIZATION_LIFETIME_MS) fail("authorization_expiry_invalid", 400);
      await store.update(state => {
        validateTransferRegistryState(state);
        if (binding.expiresAt <= now()) fail("authorization_expiry_invalid", 400);
        // Only short-lived registry metadata is pruned. Source records and their
        // idempotency/inspection/storage accounting are in separate stores.
        for (const [key, entry] of Object.entries(state.grants)) if (entry.binding.expiresAt <= time) delete state.grants[key];
        const previous = state.grants[hash];
        if (previous) {
          if (JSON.stringify(canonicalBinding(previous.binding)) !== JSON.stringify(binding)) fail("authorization_conflict", 409);
          if (previous.revoked) fail("authorization_revoked", 410);
          return;
        }
        if (Object.keys(state.grants).length >= maxActiveRecords) fail("registry_full", 429);
        state.grants[hash] = { binding, revoked: false };
      });
      return { authorizationId, ...binding };
    }); },
    async resolve(authorizationId) { return safe(async () => {
      const hash = authorizationHash(authorizationId), time = now();
      const binding = await store.update(state => {
        validateTransferRegistryState(state);
        const entry = state.grants[hash];
        if (!entry) return null;
        if (entry.binding.expiresAt <= time) { delete state.grants[hash]; return null; }
        return entry.revoked ? null : canonicalBinding(entry.binding);
      });
      return binding ? { authorizationId, ...binding } : null;
    }); },
    async revoke(authorizationId) { return safe(async () => {
      const hash = authorizationHash(authorizationId), time = now();
      return store.update(state => {
        validateTransferRegistryState(state);
        const entry = state.grants[hash];
        if (!entry) return false;
        if (entry.binding.expiresAt <= time) { delete state.grants[hash]; return false; }
        // Keep the binding until its original expiry to prevent re-registration
        // from resurrecting a revoked bearer grant.
        entry.revoked = true;
        return true;
      });
    }); }
  });
}

module.exports = { createTransferAuthorizationRegistry, createMemoryTransferRegistryStore,
  freshTransferRegistryState, validateTransferRegistryState, TransferRegistryError,
  MAX_ACTIVE_RECORDS, MAX_DOCUMENT_BYTES, MAX_AUTHORIZATION_LIFETIME_MS };
