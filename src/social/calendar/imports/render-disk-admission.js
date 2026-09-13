"use strict";

// Server-held storage coordinator wrapper. It never creates an FFmpeg task and
// is not an HTTP facade. Filesystem reads below independently verify cleanup.
const crypto = require("node:crypto"), fs = require("node:fs/promises"), path = require("node:path");
const { constants } = require("node:fs");
const { isDeepStrictEqual } = require("node:util");
const { validateDiskUploadRecord } = require("./render-disk-provider");
const { isDiskSpaceGuard } = require("./disk-space-guard");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const METADATA_MARGIN = 65536;
const KEYS = ["reservationKey", "companyId", "userId", "assetId", "sourceSha256", "sourceBytes", "peakBytes"];
const NAMESPACE = Buffer.from("e373c084355b5e3aba1a992f640b9c48", "hex");
function fail(code = "disk_admission_unavailable") { throw Object.assign(new Error(code), { code }); }
function canonical(binding) {
  if (!binding || ![Object.prototype, null].includes(Object.getPrototypeOf(binding)) ||
      Object.keys(binding).length !== KEYS.length || Object.keys(binding).some(key => !KEYS.includes(key)) ||
      ![binding.companyId, binding.userId, binding.assetId].every(value => UUID.test(value || "")) ||
      !HASH.test(binding.sourceSha256 || "") || binding.reservationKey !== `disk:${binding.assetId}` ||
      !Number.isSafeInteger(binding.sourceBytes) || binding.sourceBytes < 1 || binding.sourceBytes > 100 * 1024 ** 2 ||
      binding.peakBytes !== binding.sourceBytes * 2 + METADATA_MARGIN) fail("disk_reservation_binding_invalid");
  return Object.fromEntries(KEYS.map(key => [key, binding[key]]));
}
function renderDiskCapacityIdentity(binding) {
  const value = canonical(binding);
  const bytes = crypto.createHash("sha1").update(NAMESPACE).update(value.reservationKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex"), jobId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const requestDigest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { jobId, requestDigest };
}
function createRenderDiskAdmission({ capacity, store, rootDirectory, coordinatorContext, enabled = false, allowVolatileForTests = false,
  requireDiskSpaceEvidence = false, diskSpaceGuard } = {}) {
  const durable = capacity?.capabilities?.persistence === "durable" && store?.capabilities?.persistence === "durable";
  const needsDiskSpace = requireDiskSpaceEvidence || capacity?.capabilities?.requiresDiskSpaceEvidence === true;
  const guarded = isDiskSpaceGuard(diskSpaceGuard, { rootDirectory, allowVolatileForTests }) &&
    typeof capacity?.acceptsDiskSpaceGuard === "function" && capacity.acceptsDiskSpaceGuard(diskSpaceGuard) === true;
  const available = Boolean(enabled && path.isAbsolute(rootDirectory || "") && capacity?.capabilities?.available === true &&
    capacity?.capabilities?.atomicGlobalReservations === true && store?.capabilities?.atomicCompanyUpdates === true &&
    coordinatorContext?.authenticated === true && coordinatorContext?.role === "calendar_media_capacity_coordinator" &&
    typeof store.update === "function" && ["reserveStorage", "sealStorage", "assertHeld", "cancel", "settleStorage", "inspect"].every(method => typeof capacity?.[method] === "function") &&
    typeof requireDiskSpaceEvidence === "boolean" && (!needsDiskSpace || guarded) &&
    (durable || allowVolatileForTests && capacity?.capabilities?.testOnly === true && store?.capabilities?.persistence === "volatile-test"));
  const context = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
  const root = path.resolve(rootDirectory || ".");
  async function safe(operation) {
    if (!available) fail();
    try { return await operation(); }
    catch (error) {
      if (/^disk_[a-z_]{1,80}$/.test(error?.code || "")) fail(error.code);
      if (/^media_capacity_[a-z_]{1,80}$/.test(error?.code || "")) fail("disk_global_capacity_refused");
      fail();
    }
  }
  async function owned(binding) {
    const value = canonical(binding);
    return store.update(value.companyId, state => {
      const matches = Object.values(state.uploads || {}).filter(row => row.assetId === value.assetId);
      if (matches.length !== 1) fail("disk_reservation_owner_invalid");
      const row = validateDiskUploadRecord(matches[0]);
      if (row.companyId !== value.companyId || row.userId !== value.userId || row.sha256 !== value.sourceSha256 ||
          row.sizeBytes !== value.sourceBytes || !row.disk) fail("disk_reservation_owner_invalid");
      return structuredClone(row);
    });
  }
  function request(binding) {
    const value = canonical(binding);
    return { context, ...renderDiskCapacityIdentity(value), companyId: value.companyId, userId: value.userId };
  }
  function verifyReceipt(receipt, binding, minimum) {
    const identity = renderDiskCapacityIdentity(binding);
    if (!receipt || receipt.jobId !== identity.jobId || receipt.requestDigest !== identity.requestDigest ||
        receipt.companyId !== binding.companyId || receipt.userId !== binding.userId ||
        receipt.storageBytes !== binding.peakBytes || receipt.sourceBytes !== binding.sourceBytes || receipt.purpose !== "storage" || receipt.runtimeBudgetMs !== 0 ||
        receipt.storageHeld !== true || !Number.isSafeInteger(receipt.heldBytes) || receipt.heldBytes < minimum) fail("disk_reservation_missing");
  }
  async function checkedDirectory(dirname) {
    const stat = await fs.lstat(dirname);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(dirname)) !== dirname ||
        process.platform !== "win32" && ((stat.mode & 0o077) || typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("disk_cleanup_evidence_invalid");
  }
  async function inspectFile(dirname, filename, maxBytes, json = false, expectedSha256) {
    const location = path.join(dirname, filename), before = await fs.lstat(location);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) fail("disk_cleanup_evidence_invalid");
    const handle = await fs.open(location, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const current = await handle.stat();
      if (current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size) fail("disk_cleanup_evidence_invalid");
      if (expectedSha256) {
        const buffer = Buffer.allocUnsafe(65536), digest = crypto.createHash("sha256"); let count = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
          if (!bytesRead) break;
          count += bytesRead; if (count > maxBytes) fail("disk_seal_evidence_invalid");
          digest.update(buffer.subarray(0, bytesRead));
        }
        if (count !== current.size || digest.digest("hex") !== expectedSha256) fail("disk_seal_evidence_invalid");
      }
      return json ? JSON.parse(await handle.readFile("utf8")) : current.size;
    } finally { await handle.close(); }
  }
  async function evidence(row, binding, seal = false) {
    if (root === path.parse(root).root) fail("disk_cleanup_evidence_invalid");
    await checkedDirectory(root);
    const dirname = path.join(root, row.objectKey); await checkedDirectory(dirname);
    const identity = await inspectFile(dirname, "identity.json", METADATA_MARGIN, true);
    if (!isDeepStrictEqual(identity, { ...canonical(binding), uploadId: row.disk.uploadId, objectVersion: row.disk.objectVersion })) fail("disk_cleanup_evidence_invalid");
    const names = await fs.readdir(dirname);
    if (!names.includes("operation.lock")) fail("disk_cleanup_evidence_invalid");
    await inspectFile(dirname, "operation.lock", 0);
    if (!seal) {
      if (names.some(name => !["identity.json", "operation.lock"].includes(name))) fail("disk_cleanup_evidence_invalid");
      if (row.state !== "cancel_pending" || row.disk.phase !== "aborting" || row.disk.cleanupVerified !== true) fail("disk_cleanup_evidence_invalid");
      return crypto.createHash("sha256").update(`disk-abort-metadata-retained:${renderDiskCapacityIdentity(binding).requestDigest}:${row.disk.objectVersion}`).digest("hex");
    }
    if (row.disk.phase !== "sealed" || !Array.isArray(row.disk.manifest)) fail("disk_seal_evidence_invalid");
    const sourceSize = await inspectFile(dirname, "source.bin", binding.sourceBytes, false, binding.sourceSha256);
    if (sourceSize !== binding.sourceBytes) fail("disk_seal_evidence_invalid");
    const receipt = await inspectFile(dirname, "seal.json", 32768, true);
    if (!isDeepStrictEqual(receipt, { objectVersion: row.disk.objectVersion, sha256: row.sha256,
      sizeBytes: row.sizeBytes, manifest: row.disk.manifest })) fail("disk_seal_evidence_invalid");
    return crypto.createHash("sha256").update(`disk-source-sealed:${renderDiskCapacityIdentity(binding).requestDigest}:${row.disk.objectVersion}`).digest("hex");
  }
  return Object.freeze({
    capabilities: Object.freeze({ persistence: durable ? "durable" : "volatile-test", testOnly: !durable,
      atomicGlobalReservations: available, storageOnly: true, financialHardCap: false, requiresDiskSpaceEvidence: needsDiskSpace }),
    async reserve(binding) { return safe(async () => {
      const value = canonical(binding); await owned(value);
      const diskSpaceEvidence = needsDiskSpace ? await diskSpaceGuard.sample() : undefined;
      const result = await capacity.reserveStorage({ ...request(value), storageBytes: value.peakBytes, sourceBytes: value.sourceBytes, diskSpaceEvidence });
      verifyReceipt(result, value, value.peakBytes); return { held: true, binding: value };
    }); },
    async assertHeld(binding, { intent = "write" } = {}) { return safe(async () => {
      const value = canonical(binding); await owned(value);
      const diskSpaceEvidence = needsDiskSpace && intent === "write" ? await diskSpaceGuard.sample() : undefined;
      const result = await capacity.assertHeld({ ...request(value), intent, diskSpaceEvidence });
      verifyReceipt(result, value, value.peakBytes);
      return { held: true, binding: value };
    }); },
    async sealStorage(binding) { return safe(async () => {
      const value = canonical(binding), row = await owned(value), proofId = await evidence(row, value, true);
      const current = await capacity.inspect({ context, jobId: renderDiskCapacityIdentity(value).jobId });
      verifyReceipt(current, value, value.peakBytes);
      return capacity.sealStorage({ context, jobId: current.jobId, remainingBytes: value.peakBytes, proofId });
    }); },
    async releaseAfterAbort(binding) { return safe(async () => {
      const value = canonical(binding), row = await owned(value), proofId = await evidence(row, value);
      const current = await capacity.inspect({ context, jobId: renderDiskCapacityIdentity(value).jobId });
      verifyReceipt(current, value, METADATA_MARGIN);
      await capacity.cancel({ context, jobId: current.jobId });
      // Identity tombstone remains on disk: do NOT claim zero bytes or call
      // recordCleanup. Charge its conservative 64 KiB margin until real removal.
      return capacity.settleStorage({ context, jobId: current.jobId, remainingBytes: METADATA_MARGIN, proofId });
    }); }
  });
}

module.exports = { createRenderDiskAdmission, renderDiskCapacityIdentity, METADATA_MARGIN };
