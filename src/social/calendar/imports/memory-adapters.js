"use strict";

// TEST-ONLY adapters. They simulate the remote boundary, have no durability, and
// deliberately cannot be enabled without allowVolatileForTests in the service.
const crypto = require("node:crypto");
const { freshImportUploadState } = require("./upload-service");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const copy = value => structuredClone(value);

function createMemoryImportUploadStore() {
  const rows = new Map(), tails = new Map();
  return Object.freeze({
    capabilities: Object.freeze({ persistence: "volatile-test", atomicCompanyUpdates: true }),
    async update(companyId, mutation) {
      const prior = tails.get(companyId) || Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      tails.set(companyId, current);
      await prior;
      try {
        const state = copy(rows.get(companyId) || freshImportUploadState());
        const result = mutation(state);
        if (result && typeof result.then === "function") throw new Error("memory_store_sync_mutation_required");
        // Clone before commit: no live references escape an atomic update.
        const response = copy(result);
        rows.set(companyId, copy(state));
        return response;
      } finally {
        release();
        if (tails.get(companyId) === current) tails.delete(companyId);
      }
    },
    snapshotForTest(companyId) { return copy(rows.get(companyId) || freshImportUploadState()); }
  });
}

function createMemoryMultipartProvider({ inspectBytes, clock = Date.now } = {}) {
  const sessions = new Map(), grants = new Map();
  const calls = { begin: 0, finalize: 0, inspect: 0, abort: 0 };
  function sessionFor(objectKey, uploadId) {
    const session = sessions.get(objectKey);
    if (!session || session.aborted || session.uploadId !== uploadId) throw new Error("memory_provider_upload_unavailable");
    return session;
  }
  function manifest(session) {
    return [...session.parts.entries()].map(([partNumber, bytes]) => ({ partNumber, sizeBytes: bytes.length, sha256: digest(bytes) })).sort((a, b) => a.partNumber - b.partNumber);
  }
  return Object.freeze({
    capabilities: Object.freeze({ testOnly: true, privateObjects: true, metadataOnly: true,
      actualInspection: typeof inspectBytes === "function", idempotentMultipart: true, immutableFinalObjects: true }),
    async beginMultipart({ objectKey, sizeBytes, chunkBytes }) {
      calls.begin++;
      if (!/^[0-9a-f]{64}$/.test(objectKey)) throw new Error("memory_provider_key_invalid");
      const existing = sessions.get(objectKey);
      if (existing) {
        if (existing.aborted || existing.sizeBytes !== sizeBytes || existing.chunkBytes !== chunkBytes) throw new Error("memory_provider_key_conflict");
        return { uploadId: existing.uploadId };
      }
      const session = { uploadId: crypto.randomUUID(), sizeBytes, chunkBytes, parts: new Map(), objectVersion: null, bytes: null, aborted: false };
      sessions.set(objectKey, session);
      return { uploadId: session.uploadId };
    },
    async authorizePart({ objectKey, uploadId, partNumber, sizeBytes, expiresAt }) {
      const session = sessionFor(objectKey, uploadId);
      if (session.objectVersion) throw new Error("memory_provider_upload_sealed");
      const expected = Math.min(session.chunkBytes, session.sizeBytes - (partNumber - 1) * session.chunkBytes);
      if (partNumber < 1 || !Number.isSafeInteger(partNumber) || sizeBytes < 1 || sizeBytes !== expected) throw new Error("memory_provider_part_invalid");
      const authorizationId = crypto.randomUUID();
      grants.set(authorizationId, { objectKey, uploadId, partNumber, sizeBytes, expiresAt });
      return { authorizationId, expiresAt };
    },
    // A simulated client calls this test helper directly, not the metadata API.
    // Buffers exist only here to emulate external storage in deterministic tests.
    async receivePartForTest(authorizationId, bytes) {
      const grant = grants.get(authorizationId);
      if (!grant || grant.expiresAt <= clock() || !Buffer.isBuffer(bytes) || bytes.length !== grant.sizeBytes) throw new Error("memory_provider_authorization_invalid");
      const session = sessionFor(grant.objectKey, grant.uploadId);
      if (session.objectVersion) throw new Error("memory_provider_upload_sealed");
      session.parts.set(grant.partNumber, Buffer.from(bytes));
      return { partNumber: grant.partNumber, sizeBytes: bytes.length, sha256: digest(bytes) };
    },
    async listParts({ objectKey, uploadId }) { return manifest(sessionFor(objectKey, uploadId)); },
    async finalizeMultipart({ objectKey, uploadId, parts }) {
      const session = sessionFor(objectKey, uploadId);
      const actual = manifest(session);
      if (JSON.stringify(actual) !== JSON.stringify(parts) || actual.length !== Math.ceil(session.sizeBytes / session.chunkBytes)) throw new Error("memory_provider_manifest_conflict");
      if (!session.objectVersion) {
        calls.finalize++;
        session.bytes = Buffer.concat(actual.map(part => session.parts.get(part.partNumber)));
        if (session.bytes.length !== session.sizeBytes) throw new Error("memory_provider_size_conflict");
        session.objectVersion = crypto.randomUUID();
      }
      return { objectVersion: session.objectVersion };
    },
    async inspectObject({ objectKey, objectVersion }) {
      const session = sessions.get(objectKey);
      if (!session || !session.bytes || session.aborted || session.objectVersion !== objectVersion || typeof inspectBytes !== "function") throw new Error("memory_provider_inspector_unavailable");
      calls.inspect++;
      const inspection = await inspectBytes(Buffer.from(session.bytes));
      // Digest and byte count are calculated from the stored bytes even if an
      // injected test inspector mistakenly returns client-like metadata.
      return { ...inspection, complete: true, sizeBytes: session.bytes.length, sha256: digest(session.bytes) };
    },
    async abortMultipart({ objectKey }) {
      calls.abort++;
      const session = sessions.get(objectKey);
      if (session?.objectVersion) throw new Error("memory_provider_completed_object_not_aborted");
      if (session) { session.aborted = true; session.parts.clear(); }
      else sessions.set(objectKey, { aborted: true });
      for (const [key, grant] of grants) if (grant.objectKey === objectKey) grants.delete(key);
      return { aborted: true, objectExists: false };
    },
    statsForTest() { return { ...calls, sessions: sessions.size, completedObjects: [...sessions.values()].filter(row => row.objectVersion).length }; }
  });
}

module.exports = { createMemoryImportUploadStore, createMemoryMultipartProvider };
