"use strict";

// Candidate maintenance operation, not mounted and never started by the API.
// Removes only a completed multipart-abort's identity.json + empty directory.
// Media sources, derivatives, calendars, execution receipts and old DATA_DIR
// are deliberately outside this collector. An immutable DB fence precedes FS IO.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { constants } = require("node:fs"), { isDeepStrictEqual } = require("node:util");
const { withTransaction } = require("../../../persistence/postgres/pool");
const { createImportUploadPostgresStore, validateImportUploadState } = require("./postgres-store");
const { createCalendarStore } = require("../store");
const { freshState } = require("../model");
const { classifyRetention, validateRetentionState } = require("./retention-policy");
const { renderDiskCapacityIdentity, METADATA_MARGIN } = require("./render-disk-admission");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ROLE = "ia4tube_social_runtime", hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const COORDINATOR = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
function fail(code) { throw Object.assign(new Error(`media_retention_${code}`), { code: `media_retention_${code}`, statusCode: 409 }); }
function createReferencedRetentionCollector({ pool, rootDirectory, capacityPool, enabled = false,
  policy = { mode: "retain_all" }, clock = Date.now } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof clock !== "function") fail("configuration_invalid");
  if (!policy || !["retain_all", "terminal_upload_tombstones"].includes(policy.mode) ||
      Object.keys(policy).some(key => !["mode", "minimumAgeMs", "approvalReference"].includes(key)) ||
      policy.mode === "terminal_upload_tombstones" && (!Number.isSafeInteger(policy.minimumAgeMs) || policy.minimumAgeMs < 0 ||
        !/^[a-zA-Z0-9_-]{8,80}$/.test(policy.approvalReference || ""))) fail("policy_not_approved");
  const chosen = Object.freeze({ ...policy });
  const root = path.resolve(rootDirectory || ".");
  const available = enabled === true && path.isAbsolute(rootDirectory || "") && root !== path.parse(root).root && !/^[/\\]{2}/.test(root);
  const imports = createImportUploadPostgresStore({ pool, role: ROLE }), calendar = createCalendarStore({ pool, role: ROLE });
  const capacityStore = capacityPool ? require("./postgres-global-capacity-store").createPostgresGlobalCapacityStore({ pool: capacityPool }) : null;
  const capacity = capacityStore ? require("./global-capacity").createGlobalMediaCapacity({ store: capacityStore, enabled: true, clock }) : null;
  function now() { const n = clock(); if (!Number.isSafeInteger(n) || n < 1) fail("clock_invalid"); return n; }
  function assert() { if (!available) fail("disabled"); }
  async function directory(target) {
    const st = await fs.lstat(target);
    if (!st.isDirectory() || st.isSymbolicLink() || path.resolve(await fs.realpath(target)) !== target ||
        process.platform !== "win32" && ((st.mode & 0o077) || st.uid !== process.getuid())) fail("directory_unsafe");
  }
  async function syncDirectory(target) {
    if (process.platform === "win32") return;
    const fd = await fs.open(target, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    try { await fd.sync(); } finally { await fd.close(); }
  }
  function binding(upload) { return { reservationKey: `disk:${upload.assetId}`, companyId: upload.companyId, userId: upload.userId,
    assetId: upload.assetId, sourceSha256: upload.sha256, sourceBytes: upload.sizeBytes, peakBytes: upload.sizeBytes * 2 + METADATA_MARGIN }; }
  async function identity(upload, intent) {
    await directory(root);
    const dirname = path.join(root, upload.objectKey);
    if (!/^[a-f0-9]{64}$/.test(upload.objectKey || "") || path.dirname(dirname) !== root) fail("path_invalid");
    try { await directory(dirname); } catch (error) { if (error.code === "ENOENT" && intent) return { dirname, absent: true }; throw error; }
    const names = await fs.readdir(dirname);
    if (!names.length && intent) return { dirname, empty: true };
    if (names.length !== 1 || names[0] !== "identity.json") fail("unaccounted_files");
    const filename = path.join(dirname, "identity.json"), before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > METADATA_MARGIN) fail("file_unsafe");
    const fd = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const during = await fd.stat();
      if (during.dev !== before.dev || during.ino !== before.ino || during.size !== before.size || during.nlink !== 1) fail("file_changed");
      bytes = await fd.readFile();
      const after = await fd.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("file_changed");
    } finally { await fd.close(); }
    let parsed; try { parsed = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("identity_invalid"); }
    if (!isDeepStrictEqual(parsed, { ...binding(upload), uploadId: upload.disk.uploadId, objectVersion: upload.disk.objectVersion })) fail("identity_invalid");
    const manifestSha256 = hash(bytes);
    if (intent && (manifestSha256 !== intent.manifestSha256 || bytes.length !== intent.identityBytes)) fail("identity_changed");
    return { dirname, filename, manifestSha256, identityBytes: bytes.length };
  }
  async function transaction(companyId, operation) {
    if (!UUID.test(companyId || "")) fail("owner_invalid");
    return withTransaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`calendar:${companyId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`calendar-import:${companyId}`]);
      const cal = await client.query("SELECT document FROM ia4tube_calendar.owner_state WHERE company_id=$1 FOR UPDATE", [companyId]);
      const found = await client.query("SELECT document FROM ia4tube_calendar.import_upload_state WHERE company_id=$1 FOR UPDATE", [companyId]);
      if (found.rows.length !== 1) fail("not_found");
      const state = validateImportUploadState(found.rows[0].document, companyId), before = JSON.stringify(state);
      const result = await operation(state, cal.rows[0]?.document || freshState());
      validateImportUploadState(state, companyId);
      if (before !== JSON.stringify(state)) await client.query(`UPDATE ia4tube_calendar.import_upload_state
        SET document=$2::jsonb,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE company_id=$1`, [companyId, JSON.stringify(state)]);
      return structuredClone(result);
    }, { companyId, role: ROLE });
  }
  async function read(companyId, uploadId) {
    if (!UUID.test(uploadId || "")) fail("request_invalid");
    return transaction(companyId, (state, cal) => {
      const classification = classifyRetention(state, cal, uploadId, now()), upload = state.uploads[uploadId];
      return { classification, upload, intent: state.retention?.records?.[upload.assetId] || null };
    });
  }
  async function verified() { assert(); await imports.verify(); await calendar.verify(); await directory(root); }
  async function cancelledReservation(upload) {
    if (!capacityStore) fail("reservation_unconfirmed");
    await capacityStore.verify();
    const expected = binding(upload), capacityIdentity = renderDiskCapacityIdentity(expected);
    const receipt = await capacity.inspect({ context: COORDINATOR, jobId: capacityIdentity.jobId });
    if (receipt.companyId !== upload.companyId || receipt.userId !== expected.userId || receipt.requestDigest !== capacityIdentity.requestDigest ||
        receipt.purpose !== "storage" || !["storage_cancel_requested", "storage_released"].includes(receipt.state) ||
        receipt.storageBytes !== expected.peakBytes || receipt.sourceBytes !== expected.sourceBytes) fail("reservation_unconfirmed");
    return receipt;
  }
  return Object.freeze({
    capabilities: Object.freeze({ available, mode: chosen.mode, scheduledDeletion: false, mediaDeletion: false,
      candidateOnly: true, financialHardCap: false }),
    async inspect({ companyId, uploadId }) {
      await verified(); const row = await read(companyId, uploadId);
      return { ...row.classification, policyAllowsCleanup: chosen.mode === "terminal_upload_tombstones" &&
        row.classification.terminalTombstone && row.classification.ageMs >= chosen.minimumAgeMs };
    },
    async retire({ companyId, uploadId }) {
      await verified(); if (chosen.mode !== "terminal_upload_tombstones") fail("policy_preserve_all");
      await cancelledReservation((await read(companyId, uploadId)).upload);
      // No filesystem deletion can happen until the immutable fence is committed.
      await transaction(companyId, async (state, cal) => {
        const classification = classifyRetention(state, cal, uploadId, now()), upload = state.uploads[uploadId];
        if (!classification.terminalTombstone || classification.ageMs < chosen.minimumAgeMs) fail("still_referenced_or_active");
        const previous = state.retention?.records?.[upload.assetId]; if (previous) return;
        const observed = await identity(upload);
        state.retention ||= { schema: 1, records: {} };
        state.retention.records[upload.assetId] = { schema: 1, cleanupId: crypto.randomUUID(), companyId, userId: upload.userId,
          assetId: upload.assetId, uploadId, objectKey: upload.objectKey, objectVersion: upload.disk.objectVersion,
          phase: "intent", createdAt: now(), manifestSha256: observed.manifestSha256, identityBytes: observed.identityBytes };
        validateRetentionState(state.retention, companyId, state.uploads);
      });
      // Re-read durable intent (also makes an acknowledged intent idempotent).
      let row = await read(companyId, uploadId);
      if (!row.intent || !row.classification.terminalTombstone) fail("fence_unconfirmed");
      const observed = await identity(row.upload, row.intent);
      if (row.intent.phase === "files_removed" && !observed.absent) fail("files_reappeared");
      if (observed.filename) {
        // No recursive delete, chmod or broad-directory cleanup. If another file
        // exists or is introduced, rmdir fails and storage stays held.
        await fs.unlink(observed.filename); await syncDirectory(observed.dirname);
      }
      if (!observed.absent) { await fs.rmdir(observed.dirname); await syncDirectory(root); }
      const after = await identity(row.upload, row.intent); if (!after.absent) fail("removal_unconfirmed");
      const proof = hash(`terminal-upload-tombstone:${row.intent.cleanupId}:${row.intent.manifestSha256}:${row.intent.objectVersion}`);
      await transaction(companyId, (state, cal) => {
        const current = state.retention.records[row.upload.assetId];
        if (current.cleanupId !== row.intent.cleanupId || !classifyRetention(state, cal, uploadId, now()).terminalTombstone) fail("fence_changed");
        current.phase = "files_removed"; current.cleanupProof = proof; current.removedAt ||= now();
      });
      // Reservation release is optional but never inferred from caller flags.
      // It derives the exact capacity identity, observes a cancelled storage
      // reservation, and rechecks absence. Any ambiguity keeps accounting held.
      let reservationReleased = false;
      if (capacity) {
        await capacityStore.verify();
        row = await read(companyId, uploadId);
        const expected = binding(row.upload), capacityIdentity = renderDiskCapacityIdentity(expected);
        const receipt = await capacity.inspect({ context: COORDINATOR, jobId: capacityIdentity.jobId });
        if (receipt.companyId !== companyId || receipt.userId !== expected.userId || receipt.requestDigest !== capacityIdentity.requestDigest ||
            receipt.purpose !== "storage" || !["storage_cancel_requested", "storage_released"].includes(receipt.state) ||
            receipt.storageBytes !== expected.peakBytes || receipt.sourceBytes !== expected.sourceBytes ||
            row.intent.phase !== "files_removed" || row.intent.cleanupProof !== proof || !(await identity(row.upload, row.intent)).absent) fail("reservation_unconfirmed");
        await capacity.recordCleanup({ context: COORDINATOR, jobId: capacityIdentity.jobId, proofId: proof }); reservationReleased = true;
      }
      return { filesRemoved: true, reservationReleased, deletedMediaFiles: 0, removedIdentityTombstones: 1 };
    }
  });
}
module.exports = { createReferencedRetentionCollector };
