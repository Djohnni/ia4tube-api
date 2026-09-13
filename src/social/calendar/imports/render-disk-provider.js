"use strict";

// Byte-storage foundation only. No HTTP mount, decoder, FFmpeg, or production
// activation is performed here. The caller supplies a dedicated private root.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { CalendarImportUploadError } = require("./upload-service");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CHUNK = 5 * 1024 * 1024, MAX_SOURCE = 100 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;
function fail(code = "disk_operation_unavailable") { throw Object.assign(new Error(code), { code }); }
// jsonb preserves the exact values, not JavaScript insertion order. Arrays
// remain ordered and extra/missing keys still fail this structural comparison.
function same(a, b) { return require("node:util").isDeepStrictEqual(a, b); }
function md5(value) { return typeof value === "string" && /^[A-Za-z0-9+/]{22}==$/.test(value) && Buffer.from(value, "base64").toString("base64") === value; }
function validateDiskUploadRecord(row) {
  if (!row || !UUID.test(row.companyId || "") || !UUID.test(row.userId || "") || !UUID.test(row.assetId || "") ||
      !HASH.test(row.objectKey || "") || !HASH.test(row.sha256 || "") || !Number.isSafeInteger(row.sizeBytes) ||
      row.sizeBytes < 1 || row.sizeBytes > MAX_SOURCE || row.chunkBytes !== MAX_CHUNK) fail("disk_record_invalid");
  const disk = row.disk;
  if (disk !== undefined && (!disk || typeof disk !== "object" || Array.isArray(disk))) fail("disk_record_invalid");
  if (disk && (disk.schema !== 1 || !UUID.test(disk.uploadId || "") || !UUID.test(disk.objectVersion || "") ||
      !["created", "open", "sealing", "sealed", "aborting", "aborted"].includes(disk.phase) ||
      !disk.parts || typeof disk.parts !== "object" || Array.isArray(disk.parts) ||
      Object.keys(disk.parts).length > Math.ceil(row.sizeBytes / row.chunkBytes))) fail("disk_record_invalid");
  if (disk) for (const [key, part] of Object.entries(disk.parts)) {
    const number = Number(key), expected = Math.min(row.chunkBytes, row.sizeBytes - (number - 1) * row.chunkBytes);
    if (!/^[1-9][0-9]?$/.test(key) || number > Math.ceil(row.sizeBytes / row.chunkBytes) ||
        !part || part.sizeBytes !== expected || !HASH.test(part.sha256 || "") || !md5(part.md5Base64) ||
        !UUID.test(part.authorizationId || "") || !Number.isSafeInteger(part.expiresAt)) fail("disk_record_invalid");
  }
  if (disk) {
    if (disk.phase === "created" && (Object.keys(disk.parts).length || row.providerUploadId !== undefined ||
        ["manifest", "inspectionRequested", "inspectionResult", "cleanupVerified"].some(key => disk[key] !== undefined))) fail("disk_record_invalid");
    if (disk.cleanupVerified !== undefined && (disk.cleanupVerified !== true ||
        !["aborting", "aborted"].includes(disk.phase) || !["cancel_pending", "cancelled"].includes(row.state))) fail("disk_record_invalid");
    if (["aborting", "aborted"].includes(disk.phase) && !["cancel_pending", "cancelled"].includes(row.state) ||
        disk.phase === "aborted" && (disk.cleanupVerified !== true || Object.keys(disk.parts).length)) fail("disk_record_invalid");
    if (["sealing", "sealed"].includes(disk.phase) && !Array.isArray(disk.manifest)) fail("disk_record_invalid");
    if (disk.manifest !== undefined) {
      if (!["sealing", "sealed"].includes(disk.phase) || !Array.isArray(disk.manifest) ||
          disk.manifest.length !== Math.ceil(row.sizeBytes / row.chunkBytes)) fail("disk_record_invalid");
      for (const [index, part] of disk.manifest.entries()) {
        const grant = disk.parts[index + 1];
        if (!part || part.partNumber !== index + 1 || !grant || part.sizeBytes !== grant.sizeBytes || part.sha256 !== grant.sha256 ||
            Object.keys(part).length !== 3) fail("disk_record_invalid");
      }
    }
    if (disk.inspectionRequested !== undefined && (disk.inspectionRequested !== true || disk.phase !== "sealed") ||
        disk.inspectionResult !== undefined && (disk.phase !== "sealed" || disk.inspectionRequested !== true)) fail("disk_record_invalid");
  }
  return row;
}

function createRenderDiskPrivateUploadProvider({ rootDirectory, store, admission, inspector,
  transferOrigin, enabled = false, allowVolatileForTests = false, clock = Date.now } = {}) {
  const durable = store?.capabilities?.persistence === "durable" && admission?.capabilities?.persistence === "durable";
  const testOnly = !durable;
  const localInspector = allowVolatileForTests === true && testOnly &&
    require("./inspection-dispatcher").isLocalDiskInspectionDispatcher(inspector);
  let origin = null;
  try { const value = new URL(transferOrigin); if (value.protocol === "https:" && !value.username && !value.password &&
    value.pathname === "/" && !value.search && !value.hash) origin = value.origin; } catch (_) { /* unavailable */ }
  const available = Boolean(enabled && path.isAbsolute(rootDirectory || "") && origin &&
    store?.capabilities?.atomicCompanyUpdates === true && typeof store.update === "function" &&
    admission?.capabilities?.atomicGlobalReservations === true &&
    ["reserve", "assertHeld", "sealStorage", "releaseAfterAbort"].every(key => typeof admission?.[key] === "function") &&
    (durable || allowVolatileForTests && store?.capabilities?.persistence === "volatile-test" && admission?.capabilities?.persistence === "volatile-test") &&
    (inspector?.capabilities?.isolated === true || localInspector) && inspector?.capabilities?.bounded === true &&
    inspector?.capabilities?.remoteObjectInspection === true &&
    typeof inspector.startInspection === "function" && typeof inspector.getInspection === "function");
  const root = path.resolve(rootDirectory || ".");
  async function safe(operation) {
    if (!available) fail("disk_provider_disabled");
    try { return await operation(); }
    catch (error) {
      if (error instanceof CalendarImportUploadError && /^import_[a-z_]{1,80}$/.test(error.code || "")) {
        throw new CalendarImportUploadError(error.code, [400, 403, 404, 409, 413, 422, 429, 503].includes(error.statusCode) ? error.statusCode : 503);
      }
      if (/^disk_[a-z_]{1,80}$/.test(error?.code || "")) fail(error.code);
      fail(); // Filesystem paths and provider details never escape.
    }
  }
  function identity(args) {
    const ctx = args?.context;
    if (ctx?.authenticated !== true || !UUID.test(ctx.companyId || "") || !UUID.test(ctx.userId || "") ||
        !HASH.test(args.objectKey || "")) fail("disk_owner_invalid");
    return ctx;
  }
  async function mutate(args, action) {
    const ctx = identity(args);
    return store.update(ctx.companyId, state => {
      const row = Object.values(state.uploads || {}).find(value => value.objectKey === args.objectKey);
      if (!row || row.companyId !== ctx.companyId || row.userId !== ctx.userId ||
          args.uploadId && args.uploadId !== row.disk?.uploadId) fail("disk_owner_invalid");
      validateDiskUploadRecord(row);
      const result = action(row);
      validateDiskUploadRecord(row);
      return result;
    });
  }
  const read = args => mutate(args, row => structuredClone(row));
  function binding(row) {
    return { reservationKey: `disk:${row.assetId}`, companyId: row.companyId, userId: row.userId,
      assetId: row.assetId, sourceSha256: row.sha256, sourceBytes: row.sizeBytes, peakBytes: row.sizeBytes * 2 + 65536 };
  }
  async function held(row, intent = "write") {
    const request = binding(row), result = await admission.assertHeld(request, { intent });
    if (!result || result.held !== true || !same(result.binding, request)) fail("disk_reservation_missing");
  }
  async function directory(directoryPath) {
    const stat = await fs.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("disk_root_unsafe");
    if (path.resolve(await fs.realpath(directoryPath)) !== path.resolve(directoryPath)) fail("disk_root_unsafe");
  }
  async function rootCheck() {
    // Dedicated root must already exist; never create a broad or default DATA_DIR.
    if (root === path.parse(root).root) fail("disk_root_unsafe");
    await directory(root);
  }
  function member(row, name) {
    if (!/^(?:[a-z0-9.-]+)$/.test(name)) fail("disk_path_invalid");
    return path.join(root, row.objectKey, name);
  }
  async function sessionDirectory(row, create = false) {
    await rootCheck();
    const dir = path.join(root, row.objectKey);
    if (create) { try { await fs.mkdir(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    await directory(dir);
    return dir;
  }
  async function syncDirectory(dir) {
    if (process.platform === "win32") return; // POSIX directory fsync is checked in Linux before activation.
    const handle = await fs.open(dir, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function openRead(filename) {
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("disk_file_unsafe");
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size) fail("disk_file_unsafe");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async function exists(filename) { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
  async function immutableJson(row, name, value, beforeCommit, assertEligible) {
    const file = member(row, name);
    if (await exists(file)) {
      const prior = await readJson(row, name);
      if (!same(prior, value)) fail("disk_receipt_conflict");
      return;
    }
    const pending = member(row, `${name}.${crypto.randomUUID()}.pending`);
    const handle = await fs.open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    try {
      if (beforeCommit) await beforeCommit();
      if (assertEligible) assertEligible();
      await fs.link(pending, file);
    } finally { await fs.unlink(pending); }
    await syncDirectory(path.dirname(file));
  }
  async function readJson(row, name) {
    const handle = await openRead(member(row, name));
    try {
      if ((await handle.stat()).size > 32768) fail("disk_receipt_invalid");
      return JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
  }
  function identityReceipt(row) { return { ...binding(row), uploadId: row.disk.uploadId, objectVersion: row.disk.objectVersion }; }
  async function verifyIdentity(row) {
    if (!same(await readJson(row, "identity.json"), identityReceipt(row))) fail("disk_identity_conflict");
  }
  async function initializeIdentity(row) {
    if (await exists(member(row, "identity.json"))) return verifyIdentity(row);
    // Called only while this invocation owns a freshly O_EXCL-created object
    // lock. A missing receipt can be restored only at the persisted initial
    // phase, before any grant/source/inspection/cleanup ever existed. An older
    // operation.lock or any other file prevents this path; nothing is deleted.
    if (row.disk.phase !== "created" || !["created", "cancel_pending"].includes(row.state) ||
        row.providerUploadId !== undefined || Object.keys(row.disk.parts).length ||
        ["manifest", "inspectionRequested", "inspectionResult", "cleanupVerified"].some(key => row.disk[key] !== undefined)) fail("disk_initialization_recovery_required");
    const names = await fs.readdir(path.join(root, row.objectKey));
    if (names.length !== 1 || names[0] !== "operation.lock") fail("disk_initialization_recovery_required");
    await immutableJson(row, "identity.json", identityReceipt(row));
  }
  async function verifySeal(row) {
    await sessionDirectory(row); await verifyIdentity(row);
    const seal = await readJson(row, "seal.json");
    if (!same(seal, { objectVersion: row.disk.objectVersion, sha256: row.sha256, sizeBytes: row.sizeBytes, manifest: row.disk.manifest })) fail("disk_seal_conflict");
  }
  async function exclusive(row, action, initializing = false) {
    await sessionDirectory(row);
    if (!initializing) await verifyIdentity(row);
    const filename = member(row, "operation.lock");
    let lock;
    try { lock = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); }
    catch (error) { if (error.code === "EEXIST") fail("disk_operation_busy_or_recovery_required"); throw error; }
    try { await lock.sync(); await syncDirectory(path.dirname(filename)); return await action(); }
    finally { await lock.close(); await fs.unlink(filename); await syncDirectory(path.dirname(filename)); }
  }
  async function digestFile(filename, expectedSize, consume) {
    const handle = await openRead(filename), hash = crypto.createHash("sha256"), md = crypto.createHash("md5");
    let count = 0;
    try {
      if ((await handle.stat()).size !== expectedSize) fail("disk_file_size_invalid");
      const buffer = Buffer.allocUnsafe(READ_CHUNK);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
        if (!bytesRead) break;
        count += bytesRead;
        if (count > expectedSize) fail("disk_file_size_invalid");
        const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); md.update(chunk);
        if (consume) await consume(chunk);
      }
      if (count !== expectedSize) fail("disk_file_size_invalid");
      return { sizeBytes: count, sha256: hash.digest("hex"), md5Base64: md.digest("base64") };
    } finally { await handle.close(); }
  }
  async function receiveBounded(stream, onChunk, timeoutMs = 30000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof stream.destroy !== "function") fail("disk_body_invalid");
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { stream.destroy(); reject(Object.assign(new Error("disk_transfer_timeout"), { code: "disk_transfer_timeout" })); }, timeoutMs);
    });
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), timeout]);
        if (next.done) return;
        await Promise.race([onChunk(next.value), timeout]);
      }
    } finally { clearTimeout(timer); stream.destroy(); }
  }
  async function parts(row) {
    const result = [];
    for (let number = 1; number <= Math.ceil(row.sizeBytes / row.chunkBytes); number++) {
      if (!await exists(member(row, `part-${number}.bin`))) continue;
      const grant = row.disk.parts[number];
      if (!grant) fail("disk_part_conflict");
      const actual = await digestFile(member(row, `part-${number}.bin`), grant.sizeBytes);
      if (actual.sha256 !== grant.sha256 || actual.md5Base64 !== grant.md5Base64) fail("disk_part_conflict");
      const receipt = { partNumber: number, sizeBytes: actual.sizeBytes, sha256: actual.sha256 };
      await immutableJson(row, `part-${number}.json`, receipt);
      result.push(receipt);
    }
    return result;
  }
  function grantFor(row, args) {
    const grant = row.disk?.parts[String(args.partNumber)];
    if (row.state !== "uploading" || row.disk.phase !== "open" || !grant ||
        grant.authorizationId !== args.authorizationId || grant.expiresAt <= clock()) fail("disk_authorization_invalid");
    return grant;
  }
  function assertWriteEligible(args) {
    // Optional trusted server closure supplied by the transfer service, never a
    // request-body flag. Policy resolution must be synchronous at commit time.
    if (args.assertWriteEligible === undefined) return;
    if (typeof args.assertWriteEligible !== "function") fail("disk_write_not_eligible");
    const decision = args.assertWriteEligible();
    if (decision && typeof decision.then === "function") Promise.resolve(decision).catch(() => {});
    if (decision !== true) fail("disk_write_not_eligible");
  }
  async function verifyWriteBinding(args) {
    // A trusted server closure can re-read durable grant revocation/binding.
    // This never runs inside a tenant-store transaction mutation callback.
    if (args.verifyWriteBinding !== undefined && (typeof args.verifyWriteBinding !== "function" ||
        await args.verifyWriteBinding() !== true)) fail("disk_write_binding_invalid");
    assertWriteEligible(args);
  }
  const provider = {
    capabilities: Object.freeze({ testOnly, privateObjects: available, metadataOnly: true, actualInspection: available,
      idempotentMultipart: available, immutableFinalObjects: available, boundedByteStorage: true }),
    getCapabilities() { return { provider: "render-private-disk", available, readyForProduction: false,
      transferRouteMounted: false, localByteDecoding: false, crashRecovery: "explicit-stopped-runtime-only" }; },
    async beginMultipart(args) { return safe(async () => {
      const row = await mutate(args, current => {
        if (args.assetId !== current.assetId || args.sizeBytes !== current.sizeBytes || args.chunkBytes !== current.chunkBytes ||
            args.checksumAlgorithm !== "SHA256") fail("disk_request_conflict");
        if (!current.disk) {
          if (current.state !== "created") fail("disk_state_conflict");
          current.disk = { schema: 1, phase: "created", uploadId: crypto.randomUUID(), objectVersion: crypto.randomUUID(), parts: {} };
        }
        if (!["created", "uploading"].includes(current.state) || !["created", "open"].includes(current.disk.phase)) fail("disk_state_conflict");
        return structuredClone(current);
      });
      await admission.reserve(binding(row)); await held(row);
      await sessionDirectory(row, true);
      return exclusive(row, async () => {
        const current = await read(args);
        if (!["created", "uploading"].includes(current.state) || !["created", "open"].includes(current.disk.phase)) fail("disk_state_conflict");
        await held(current);
        await initializeIdentity(current);
        // Cancellation may claim the tenant row while file I/O is in flight.
        // Recheck before returning a successful initialization, under our lock.
        return mutate(args, latest => {
          if (!["created", "uploading"].includes(latest.state) || !["created", "open"].includes(latest.disk.phase)) fail("disk_state_conflict");
          latest.disk.phase = "open";
          return { uploadId: latest.disk.uploadId };
        });
      }, true);
    }); },
    async authorizePart(args) { return safe(async () => {
      const row = await read(args); await held(row);
      if (!HASH.test(args.sha256 || "") || !md5(args.md5Base64) || !Number.isSafeInteger(args.expiresAt) ||
          args.expiresAt <= clock() || args.expiresAt - clock() > 600000) fail("disk_part_invalid");
      return mutate(args, current => {
        const expected = Math.min(current.chunkBytes, current.sizeBytes - (args.partNumber - 1) * current.chunkBytes);
        if (current.state !== "uploading" || current.disk.phase !== "open" || !Number.isSafeInteger(args.partNumber) ||
            args.partNumber < 1 || expected < 1 || expected !== args.sizeBytes) fail("disk_part_invalid");
        const previous = current.disk.parts[args.partNumber];
        if (previous && (previous.sha256 !== args.sha256 || previous.md5Base64 !== args.md5Base64)) fail("disk_part_conflict");
        const grant = { sizeBytes: expected, sha256: args.sha256, md5Base64: args.md5Base64,
          authorizationId: crypto.randomUUID(), expiresAt: args.expiresAt };
        current.disk.parts[args.partNumber] = grant;
        return { authorizationId: grant.authorizationId, expiresAt: grant.expiresAt };
      });
    }); },
    async resolveAuthorization(args) { return safe(async () => {
      const row = await read(args); await held(row); const grant = grantFor(row, args);
      return { url: `${origin}/v1/social/calendar/imports/bytes/${grant.authorizationId}`, method: "PUT", sizeBytes: grant.sizeBytes,
        expiresAt: grant.expiresAt, headers: { "content-length": String(grant.sizeBytes), "content-md5": grant.md5Base64,
          "x-amz-checksum-sha256": Buffer.from(grant.sha256, "hex").toString("base64") } };
    }); },
    async acceptPart(args) { return safe(async () => {
      assertWriteEligible(args);
      const row = await read(args); await held(row); const grant = grantFor(row, args);
      if (!args.stream || typeof args.stream[Symbol.asyncIterator] !== "function" || args.contentLength !== grant.sizeBytes) fail("disk_body_invalid");
      return exclusive(row, async () => {
        const current = await read(args); grantFor(current, args); await held(current);
        assertWriteEligible(args);
        const target = member(row, `part-${args.partNumber}.bin`), pending = member(row, `part-${args.partNumber}.pending`);
        // A validated existing part is immutable. Replays must contain the same
        // bounded bytes too; their body cannot be silently accepted unchecked.
        const present = await exists(target), sha = crypto.createHash("sha256"), md = crypto.createHash("md5");
        let handle, count = 0;
        await verifyWriteBinding(args); assertWriteEligible(args);
        if (!present) handle = await fs.open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        try {
          await receiveBounded(args.stream, async chunk => {
            if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail("disk_body_invalid");
            if (chunk.length > MAX_CHUNK || count + chunk.length > grant.sizeBytes) fail("disk_body_size_invalid");
            count += chunk.length; sha.update(chunk); md.update(chunk);
            if (handle) await handle.writeFile(chunk);
          }, args.timeoutMs === undefined ? 30000 : args.timeoutMs);
          if (count !== grant.sizeBytes || sha.digest("hex") !== grant.sha256 || md.digest("base64") !== grant.md5Base64) fail("disk_body_checksum_invalid");
          grantFor(await read(args), args); await held(row);
          await verifyWriteBinding(args);
          if (handle) { await handle.sync(); await handle.close(); handle = null;
            await verifyWriteBinding(args); assertWriteEligible(args);
            await fs.link(pending, target); await fs.unlink(pending); }
          const actual = await digestFile(target, grant.sizeBytes);
          if (actual.sha256 !== grant.sha256 || actual.md5Base64 !== grant.md5Base64) fail("disk_part_conflict");
          const receipt = { partNumber: args.partNumber, sizeBytes: count, sha256: actual.sha256 };
          await verifyWriteBinding(args);
          await immutableJson(row, `part-${args.partNumber}.json`, receipt, () => verifyWriteBinding(args), () => assertWriteEligible(args));
          await verifyWriteBinding(args); assertWriteEligible(args);
          return receipt;
        } finally {
          if (handle) await handle.close();
          if (!present && await exists(pending)) await fs.unlink(pending);
        }
      });
    }); },
    async listParts(args) { return safe(async () => {
      const row = await read(args); await held(row, row.disk?.phase === "sealed" ? "read" : "write");
      if (!["open", "sealing", "sealed"].includes(row.disk?.phase)) fail("disk_state_conflict");
      return exclusive(row, async () => parts(row));
    }); },
    async finalizeMultipart(args) { return safe(async () => {
      const row = await read(args); await held(row, row.disk?.phase === "sealed" ? "read" : "write");
      if (row.state !== "verifying" || !["open", "sealing", "sealed"].includes(row.disk?.phase)) fail("disk_state_conflict");
      return exclusive(row, async () => {
        const manifest = await parts(row);
        if (manifest.length !== Math.ceil(row.sizeBytes / row.chunkBytes) || !same(manifest, args.parts)) fail("disk_manifest_conflict");
        if (row.disk.phase === "sealed") {
          await verifySeal(row);
          const source = await digestFile(member(row, "source.bin"), row.sizeBytes);
          if (source.sha256 !== row.sha256) fail("disk_object_conflict");
          await admission.sealStorage(binding(row));
          return { objectVersion: row.disk.objectVersion };
        }
        await mutate(args, current => {
          if (current.disk.manifest && !same(current.disk.manifest, manifest)) fail("disk_manifest_conflict");
          current.disk.phase = "sealing"; current.disk.manifest = manifest;
        });
        const target = member(row, "source.bin"), pending = member(row, "source.pending");
        if (!await exists(target)) {
          const handle = await fs.open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
          try {
            for (const part of manifest) await digestFile(member(row, `part-${part.partNumber}.bin`), part.sizeBytes, chunk => handle.writeFile(chunk));
            await handle.sync();
          } finally { await handle.close(); }
          try {
            const actual = await digestFile(pending, row.sizeBytes);
            if (actual.sha256 !== row.sha256) throw new CalendarImportUploadError("import_media_verification_failed", 422);
            await fs.link(pending, target);
          } finally { await fs.unlink(pending); }
        }
        const actual = await digestFile(target, row.sizeBytes);
        if (actual.sha256 !== row.sha256) throw new CalendarImportUploadError("import_media_verification_failed", 422);
        await immutableJson(row, "seal.json", { objectVersion: row.disk.objectVersion, sha256: actual.sha256, sizeBytes: actual.sizeBytes, manifest });
        await mutate(args, current => { current.disk.phase = "sealed"; });
        await admission.sealStorage(binding(row));
        return { objectVersion: row.disk.objectVersion };
      });
    }); },
    async inspectObject(args) { return safe(async () => {
      const row = await read(args); await held(row, "read");
      if (row.disk?.phase !== "sealed" || args.objectVersion !== row.disk.objectVersion) fail("disk_state_conflict");
      await verifySeal(row);
      const actual = await digestFile(member(row, "source.bin"), row.sizeBytes);
      if (actual.sha256 !== row.sha256) fail("disk_object_conflict");
      if (row.disk.inspectionResult) return structuredClone(row.disk.inspectionResult);
      const first = await mutate(args, current => {
        if (current.disk.inspectionRequested) return false;
        current.disk.inspectionRequested = true; return true;
      });
      const request = { context: args.context, ticketId: row.disk.objectVersion, objectKey: row.objectKey,
        objectVersion: row.disk.objectVersion, sha256: row.sha256, sizeBytes: row.sizeBytes, kind: row.kind, deadlineMs: 180000 };
      const response = first ? await inspector.startInspection(request) : await inspector.getInspection({ context: args.context, ticketId: row.disk.objectVersion });
      if (response?.ticketId !== row.disk.objectVersion) fail("disk_inspection_invalid");
      if (response.state === "failed") throw new CalendarImportUploadError("import_media_verification_failed", 422);
      if (response.state !== "ready") fail("disk_inspection_pending");
      const result = response.result;
      if (!result || result.complete !== true || result.sha256 !== row.sha256 || result.sizeBytes !== row.sizeBytes) fail("disk_inspection_invalid");
      const verified = { complete: true, sizeBytes: actual.sizeBytes, sha256: actual.sha256,
        decoded: result.decoded === true, signatureVerified: result.signatureVerified === true,
        detectedMime: result.detectedMime, width: result.width, height: result.height,
        ...(row.kind === "image" ? { frames: result.frames } : { durationMs: result.durationMs, hasAudio: result.hasAudio, colorMode: result.colorMode }) };
      await mutate(args, current => { current.disk.inspectionResult = verified; });
      return verified;
    }); },
    async streamSealedObject(args) { return safe(async () => {
      const row = await read(args); await held(row, "read");
      if (row.disk?.phase !== "sealed" || args.objectVersion !== row.disk.objectVersion || typeof args.consume !== "function") fail("disk_read_invalid");
      // Adapter caller must authenticate its owner-bound one-job grant and set a
      // bounded deadline before invoking this byte stream; no public URL exists.
      await verifySeal(row);
      const preflight = await digestFile(member(row, "source.bin"), row.sizeBytes);
      if (preflight.sha256 !== row.sha256) fail("disk_object_conflict");
      const result = await digestFile(member(row, "source.bin"), row.sizeBytes, args.consume);
      if (result.sha256 !== row.sha256) fail("disk_object_conflict");
      return { sizeBytes: result.sizeBytes, sha256: result.sha256 };
    }); },
    async abortMultipart(args) { return safe(async () => {
      const row = await read(args);
      if (row.state !== "cancel_pending") fail("disk_state_conflict");
      if (!row.disk) return { aborted: true, objectExists: false };
      if (row.disk.phase === "aborted") return { aborted: true, objectExists: false };
      // Removing identified, owned bytes does not require write headroom: that
      // would prevent cancellation from reclaiming space on a pressured disk.
      // Retained storage must still be authorized and owner-bound.
      if (!row.disk.cleanupVerified) await held(row, "read");
      if (["sealing", "sealed"].includes(row.disk.phase)) fail("disk_abort_conflict");
      await rootCheck();
      // Recovery of an absent identity creates new metadata, so retain its full
      // write-space gate before creating a directory and again under the lock.
      if (!await exists(member(row, "identity.json"))) await held(row);
      await sessionDirectory(row, true);
      await exclusive(row, async () => {
        const current = await read(args);
        if (current.state !== "cancel_pending" || ["sealing", "sealed", "aborted"].includes(current.disk.phase)) fail("disk_abort_conflict");
        if (!current.disk.cleanupVerified) await held(current, "read");
        if (!await exists(member(current, "identity.json"))) await held(current);
        await initializeIdentity(current);
        if (await exists(member(row, "source.bin")) || await exists(member(row, "seal.json"))) fail("disk_abort_conflict");
        await mutate(args, current => { current.disk.phase = "aborting"; });
        const names = await fs.readdir(path.join(root, row.objectKey));
        for (const name of names) {
          if (name === "operation.lock" || name === "identity.json") continue;
          if (!/^part-(?:[1-9]|1[0-9]|20)\.(?:bin|json|pending)$/.test(name)) fail("disk_abort_recovery_required");
          const handle = await openRead(member(row, name)); await handle.close();
        }
        for (const name of names) if (name !== "operation.lock" && name !== "identity.json") await fs.unlink(member(row, name));
        await syncDirectory(path.join(root, row.objectKey));
        const remaining = await fs.readdir(path.join(root, row.objectKey));
        if (remaining.some(name => !["identity.json", "operation.lock"].includes(name))) fail("disk_abort_recovery_required");
        // Tombstone and reservation release remain retriable after a lost reply.
        await mutate(args, current => { current.disk.cleanupVerified = true; });
        await admission.releaseAfterAbort(binding(row));
        await mutate(args, current => { current.disk.phase = "aborted"; current.disk.parts = {}; });
      }, true);
      return { aborted: true, objectExists: false };
    }); }
  };
  return Object.freeze(provider);
}

module.exports = { createRenderDiskPrivateUploadProvider, validateDiskUploadRecord };
