"use strict";

// Local composition: no server mount, decoder, cloud task or publication.
const { isImportAccessPolicy } = require("./access-policy");
const { validateDiskUploadRecord } = require("./render-disk-provider");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OWNER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ORIGIN = "https://ia4tube-api.onrender.com";
const serviceInstances = new WeakSet();
const limiterInstances = new WeakSet();
function fail(code = "import_transfer_unavailable", statusCode = 503) {
  throw Object.assign(new Error(code), { code, statusCode });
}
function createSingleProcessTransferLimiter({ maxConcurrent = 2, maxPerCompany = 1 } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4 ||
      !Number.isSafeInteger(maxPerCompany) || maxPerCompany < 1 || maxPerCompany > maxConcurrent) fail();
  let active = 0;
  const companies = new Map();
  const limiter = Object.freeze({
    capabilities: Object.freeze({ scope: "single_process", queuedRequests: false, financialHardCap: false }),
    async run(resolve, operation) {
      // Count lookup too. Flooding unknown grants cannot start unlimited DB work.
      if (active >= maxConcurrent) fail("import_transfer_busy", 429);
      active++;
      let companyId;
      try {
        const binding = await resolve();
        if (!binding || !OWNER_UUID.test(binding.companyId || "")) fail("import_transfer_not_found", 404);
        const current = companies.get(binding.companyId) || 0;
        if (current >= maxPerCompany) fail("import_transfer_busy", 429);
        companyId = binding.companyId; companies.set(companyId, current + 1);
        return await operation(binding);
      } finally {
        if (companyId) {
          const count = companies.get(companyId) - 1;
          count ? companies.set(companyId, count) : companies.delete(companyId);
        }
        active--;
      }
    }
  });
  limiterInstances.add(limiter); return limiter;
}

function createRenderDiskTransferService({ store, provider, registry, accessPolicy,
  limiter = createSingleProcessTransferLimiter(), enabled = false, allowVolatileForTests = false,
  clock = Date.now } = {}) {
  const durable = store?.capabilities?.persistence === "durable" && registry?.capabilities?.persistence === "durable";
  const available = Boolean(enabled && store?.capabilities?.atomicCompanyUpdates === true &&
    typeof store.update === "function" && provider?.getCapabilities?.().available === true &&
    typeof provider.acceptPart === "function" && registry?.capabilities?.available === true &&
    ["register", "resolve", "revoke"].every(key => typeof registry[key] === "function") &&
    isImportAccessPolicy(accessPolicy) && accessPolicy.executionAvailable && limiterInstances.has(limiter) &&
    (durable || allowVolatileForTests && store?.capabilities?.persistence === "volatile-test" && registry?.capabilities?.testOnly === true));
  async function safe(operation) {
    if (!available) fail();
    try { return await operation(); }
    catch (error) {
      if (/^import_transfer_[a-z_]{1,60}$/.test(error?.code || "")) fail(error.code,
        [400, 403, 404, 408, 409, 413, 415, 422, 429, 503].includes(error.statusCode) ? error.statusCode : 503);
      if (error?.code === "disk_operation_busy_or_recovery_required") fail("import_transfer_busy", 409);
      if (/^disk_body_/.test(error?.code || "")) fail("import_transfer_bytes_invalid", 422);
      // No raw provider, database, source path, grant or error.cause escapes.
      fail();
    }
  }
  function owner(context) {
    try { return accessPolicy.resolve(context); }
    catch (_) { fail("import_transfer_not_found", 404); }
  }
  function bindingFor(row, partNumber, authorizationId) {
    validateDiskUploadRecord(row);
    const part = row.disk?.parts[String(partNumber)];
    if (row.state !== "uploading" || row.disk?.phase !== "open" || row.providerUploadId !== row.disk.uploadId ||
        !part || part.authorizationId !== authorizationId || part.expiresAt <= clock()) fail("import_transfer_not_found", 404);
    return { authorizationId, companyId: row.companyId, userId: row.userId, assetId: row.assetId,
      objectKey: row.objectKey, providerUploadId: row.providerUploadId, partNumber, sizeBytes: part.sizeBytes,
      sha256: part.sha256, md5Base64: part.md5Base64, expiresAt: part.expiresAt };
  }
  function sameBinding(a, b) {
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
  }
  async function currentBinding(binding) {
    const context = { authenticated: true, companyId: binding.companyId, userId: binding.userId };
    owner(context);
    const current = await store.update(context.companyId, state => {
      const rows = Object.values(state.uploads).filter(row => row.assetId === binding.assetId);
      if (rows.length !== 1 || rows[0].userId !== context.userId) fail("import_transfer_not_found", 404);
      return bindingFor(rows[0], binding.partNumber, binding.authorizationId);
    });
    owner(context);
    if (!sameBinding(current, binding)) fail("import_transfer_not_found", 404);
    return context;
  }
  const service = Object.freeze({
    available,
    // A single-process limiter is not a distributed admission controller. The
    // actual one-process topology/logging/body-parser order still needs proof.
    capabilities: Object.freeze({ metadataLookup: available, streamedBytes: available,
      readyForProduction: false, limiterScope: "single_process", financialHardCap: false }),
    async resolvePart(upload, context, input) { return safe(async () => {
      owner(context);
      if (!UUID.test(input?.authorizationId || "") || typeof upload?.resolvePart !== "function") fail("import_transfer_not_found", 404);
      const grant = await upload.resolvePart(context, input);
      const binding = await store.update(context.companyId, state => {
        const row = state.uploads[input.uploadId];
        if (!row || row.companyId !== context.companyId || row.userId !== context.userId) fail("import_transfer_not_found", 404);
        return bindingFor(row, input.partNumber, input.authorizationId);
      });
      const expected = `${ORIGIN}/v1/social/calendar/imports/bytes/${binding.authorizationId}`;
      const checksum = Buffer.from(binding.sha256, "hex").toString("base64");
      if (grant.url !== expected || grant.method !== "PUT" || grant.sizeBytes !== binding.sizeBytes ||
          grant.expiresAt !== binding.expiresAt || Object.keys(grant.headers || {}).length !== 3 ||
          grant.headers["content-length"] !== String(binding.sizeBytes) || grant.headers["content-md5"] !== binding.md5Base64 ||
          grant.headers["x-amz-checksum-sha256"] !== checksum) fail();
      await currentBinding(binding);
      await registry.register(binding);
      // A grant is never returned before durable registration. A lost commit
      // response is retried with this same identity, not a replacement upload.
      await currentBinding(binding);
      return structuredClone(grant);
    }); },
    async acceptPart({ authorizationId, contentLength, md5Base64, sha256Base64, stream, timeoutMs = 30000 }) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail();
      const deadline = performance.now() + timeoutMs;
      function remaining() {
        const left = Math.ceil(deadline - performance.now());
        if (left <= 0 || stream?.aborted === true || stream?.readableAborted === true) fail("import_transfer_timeout", 408);
        return left;
      }
      return safe(() => limiter.run(async () => {
        remaining();
        if (!UUID.test(authorizationId || "")) fail("import_transfer_not_found", 404);
        const binding = await registry.resolve(authorizationId);
        if (!binding) fail("import_transfer_not_found", 404);
        return binding;
      }, async binding => {
        remaining();
        const context = await currentBinding(binding);
        remaining();
        if (contentLength !== binding.sizeBytes || md5Base64 !== binding.md5Base64 ||
            sha256Base64 !== Buffer.from(binding.sha256, "hex").toString("base64")) fail("import_transfer_header_mismatch", 400);
        const checkedStream = (async function* () {
          // Eligibility is checked at each yielded chunk, not just when a grant
          // was issued. Provider also rechecks state/reservation before commit.
          for await (const chunk of stream) { remaining(); owner(context); yield chunk; }
          remaining(); owner(context);
        })();
        checkedStream.destroy = () => stream.destroy();
        const result = await provider.acceptPart({ context, objectKey: binding.objectKey,
          uploadId: binding.providerUploadId, partNumber: binding.partNumber, authorizationId,
          contentLength, stream: checkedStream, timeoutMs: remaining(),
          assertWriteEligible: () => { remaining(); owner(context); return true; },
          verifyWriteBinding: async () => {
            remaining();
            const observed = await registry.resolve(authorizationId);
            if (!observed || !sameBinding(observed, binding)) fail("import_transfer_not_found", 404);
            await currentBinding(binding); remaining(); return true;
          } });
        if (result?.partNumber !== binding.partNumber || result.sizeBytes !== binding.sizeBytes || result.sha256 !== binding.sha256) fail();
        return { partNumber: result.partNumber, sizeBytes: result.sizeBytes, sha256: result.sha256 };
      }));
    },
    wrapUpload(upload) {
      if (!upload || typeof upload.resolvePart !== "function") fail();
      const wrapper = Object.fromEntries(Object.keys(upload).map(key => [key,
        typeof upload[key] === "function" ? upload[key].bind(upload) : upload[key]]));
      wrapper.resolvePart = (context, input) => service.resolvePart(upload, context, input);
      return Object.freeze(wrapper);
    }
  });
  serviceInstances.add(service); return service;
}

function isRenderDiskTransferService(value) { return Boolean(value && serviceInstances.has(value)); }
module.exports = { createRenderDiskTransferService, createSingleProcessTransferLimiter, isRenderDiskTransferService };
