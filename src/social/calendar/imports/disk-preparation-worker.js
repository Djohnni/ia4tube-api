"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { createImportMediaPreparer } = require("./preparation");
const { isPreparedDiskAdmission, preparedTaskReservation } = require("./prepared-disk-admission");
const { isPreparedDiskResultStore } = require("./prepared-disk-store");
const workers = new WeakSet();
function fail(code = "unavailable") { throw Object.assign(new Error(`disk_preparation_${code}`), { code: `disk_preparation_${code}` }); }
async function directory(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(root)) !== root ||
      process.platform !== "win32" && ((stat.mode & 0o077) || typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("root_unsafe");
}
/** Worker-side local composition. Neither an OS sandbox nor an external runner.
 * Caller must actually acquire the shared task; this module cannot start a job
 * just because an HTTP request presents IDs or a claimed capability.
 */
function createDiskPreparationWorker({ provider, workingDirectory, preparationRoot, resultStore, admission,
  ffmpegPath, musicRoot, resolveMusicTrack, allowSyntheticForTests = false, allowVolatileForTests = false, clock = Date.now } = {}) {
  if (!path.isAbsolute(workingDirectory || "") || !path.isAbsolute(preparationRoot || "") || typeof provider?.streamSealedObject !== "function" ||
      !isPreparedDiskResultStore(resultStore, { allowVolatileForTests }) || !isPreparedDiskAdmission(admission, { allowVolatileForTests }) || typeof clock !== "function") fail();
  const root = path.resolve(workingDirectory), outputRoot = path.resolve(preparationRoot);
  if (root === path.parse(root).root || outputRoot === path.parse(outputRoot).root || root === outputRoot) fail("root_unsafe");
  let busy = false;
  const worker = Object.freeze({
    capabilities: Object.freeze({ localOnly: true, actualPreparation: true, osSandbox: false,
      deadlineMode: "cooperative", hardTermination: false, readyForProduction: false }),
    async execute(task, { resultRef } = {}) {
      const reservation = preparedTaskReservation(task);
      if (busy) fail("busy");
      busy = true; let attempt, handle;
      const started = performance.now();
      function remaining() {
        // Filesystem/admission awaits cannot be forcibly terminated in this
        // in-process harness. Keep its capacity until execute actually settles;
        // an isolated runtime must enforce the final process boundary.
        const left = Math.min(task.maxRuntimeMs - (performance.now() - started), task.deadlineAt - clock());
        if (left < 1) fail("deadline_exceeded"); return Math.floor(left);
      }
      async function held() {
        remaining();
        await admission.assertHeld({ task, resultRef, requiredBytes: reservation.storageBytes, intent: "write" });
        remaining();
      }
      try {
        await held(); await directory(root); await directory(outputRoot);
        attempt = await fs.mkdtemp(path.join(root, ".prepare-source-")); await fs.chmod(attempt, 0o700);
        const company = path.join(attempt, task.companyId); await fs.mkdir(company, { mode: 0o700 });
        // Internal label only; the preparer still verifies signatures and fully
        // decodes the sealed bytes instead of trusting the suffix.
        const sourceName = `${task.uploadId}.${task.selection.kind === "video" ? "mp4" : "png"}`, destination = path.join(company, sourceName);
        handle = await fs.open(destination, "wx", 0o600);
        let bytes = 0; const digest = crypto.createHash("sha256");
        await provider.streamSealedObject({ context: { authenticated: true, companyId: task.companyId, userId: task.userId },
          objectKey: task.source.objectKey, objectVersion: task.source.objectVersion, consume: async chunk => {
            remaining(); if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) || chunk.byteLength > 65536 || bytes + chunk.byteLength > task.source.sizeBytes) fail("source_invalid");
            digest.update(chunk); let offset = 0;
            while (offset < chunk.byteLength) { const write = await handle.write(chunk, offset, chunk.byteLength - offset); if (!write.bytesWritten) fail("source_invalid"); offset += write.bytesWritten; }
            bytes += chunk.byteLength;
          } });
        if (bytes !== task.source.sizeBytes || digest.digest("hex") !== task.source.sha256) fail("source_changed");
        await handle.sync(); await handle.close(); handle = null;
        await held();
        const preparer = createImportMediaPreparer({ inputRoot: attempt, outputRoot, ffmpegPath, musicRoot, resolveMusicTrack,
          allowSyntheticAudio: allowSyntheticForTests && allowVolatileForTests, clock, maxPreparationMs: remaining() });
        const prepared = await preparer.prepare({ companyId: task.companyId, assetId: task.assetId, sourceName, ...task.selection }, { deadlineAt: task.deadlineAt });
        await held();
        const result = await resultStore.commit({ task, prepared, resultRef, finishedAt: clock(), elapsedMs: Math.ceil(performance.now() - started) });
        remaining(); return result;
      } catch (error) {
        fail(/^disk_preparation_[a-z_]{1,60}$/.test(error?.code || "") ? error.code.slice(17) : "failed");
      } finally {
        try {
          if (handle) await handle.close();
          if (attempt) {
            const exact = path.resolve(attempt);
            if (path.dirname(exact) !== root || !path.basename(exact).startsWith(".prepare-source-")) fail("cleanup_failed");
            await directory(exact); await fs.rm(exact, { recursive: true, force: true });
          }
        } finally { busy = false; }
      }
    }
  });
  workers.add(worker); return worker;
}
function isDiskPreparationWorker(value) { return Boolean(value && workers.has(value)); }
module.exports = { createDiskPreparationWorker, isDiskPreparationWorker };
