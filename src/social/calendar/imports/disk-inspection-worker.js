"use strict";
// Worker-side local decoder only. Admission and OS isolation belong to its
// trusted coordinator. No remote dispatch or production activation occurs here.
const fs = require("node:fs/promises"), { constants } = require("node:fs");
const path = require("node:path"), crypto = require("node:crypto"), sharp = require("sharp");
const { LIMITS, createPreparationDeadline, runBoundedProcess, parseProbe, decodedSeconds, sniff } = require("./preparation");
const { inspectedMedia } = require("./policy");
const instances = new WeakSet();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = ["schema", "kind", "providerType", "companyId", "userId", "ticketId", "uploadId", "assetId", "dispatchKey", "executionDigest",
  "fenceToken", "objectKey", "objectVersion", "sizeBytes", "sha256", "mediaKind", "startedAt", "deadlineAt", "maxRuntimeMs"];
const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime" };
function fail(code = "unavailable") { throw Object.assign(new Error("disk_inspection_" + code), { code: "disk_inspection_" + code }); }
function validateDiskInspectionTask(task) {
  if (!task || Object.keys(task).length !== FIELDS.length || Object.keys(task).some(key => !FIELDS.includes(key)) ||
      task.schema !== 1 || task.kind !== "inspect_import" || task.providerType !== "render_disk" ||
      !["companyId", "userId", "ticketId", "uploadId", "assetId", "fenceToken", "objectVersion"].every(key => UUID.test(task[key] || "")) ||
      !["dispatchKey", "executionDigest", "objectKey", "sha256"].every(key => HASH.test(task[key] || "")) ||
      task.ticketId !== task.objectVersion || !["image", "video"].includes(task.mediaKind) ||
      !Number.isSafeInteger(task.sizeBytes) || task.sizeBytes < 1 || task.sizeBytes > LIMITS[task.mediaKind + "Bytes"] ||
      !Number.isSafeInteger(task.startedAt) || task.startedAt < 0 || !Number.isSafeInteger(task.deadlineAt) ||
      task.maxRuntimeMs !== LIMITS.processTimeoutMs || task.deadlineAt - task.startedAt !== task.maxRuntimeMs) fail("task_invalid");
  return task;
}
async function checkedPath(value, file = false) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value) || /^[/\\]{2}/.test(value) ||
      value.replace(/^[a-z]:/i, "").includes(":")) fail("path_invalid");
  const resolved = path.resolve(value), stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || path.resolve(await fs.realpath(resolved)) !== resolved ||
      (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
      !file && process.platform !== "win32" && ((stat.mode & 0o077) || typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("path_invalid");
  return stat;
}
function createDiskBoundedInspectionWorker({ provider, workingDirectory, ffmpegPath, assertExecutionHeld,
  clock = Date.now, monotonicClock = () => performance.now() } = {}) {
  if (typeof provider?.streamSealedObject !== "function" || !path.isAbsolute(workingDirectory || "") ||
      path.resolve(workingDirectory) === path.parse(path.resolve(workingDirectory)).root || typeof assertExecutionHeld !== "function" ||
      typeof clock !== "function" || typeof monotonicClock !== "function" || ffmpegPath !== undefined && !path.isAbsolute(ffmpegPath)) fail("configuration_invalid");
  const root = path.resolve(workingDirectory); let busy = false;
  const worker = Object.freeze({
    capabilities: Object.freeze({ localOnly: true, actualByteDecoding: true, osSandbox: false, maxRuntimeMs: LIMITS.processTimeoutMs,
      maxConcurrent: 1, maxSnapshotBytes: LIMITS.videoBytes, deadlineMode: "cooperative", hardTermination: false, readyForProduction: false }),
    async inspect(task) {
      validateDiskInspectionTask(task); if (busy) fail("busy");
      const budget = createPreparationDeadline({ clock, monotonicClock, deadlineAt: task.deadlineAt, maxRuntimeMs: task.maxRuntimeMs });
      async function admitted() {
        budget.remaining();
        if (await assertExecutionHeld({ task: structuredClone(task), snapshotBytes: task.sizeBytes, maxRuntimeMs: task.maxRuntimeMs }) !== true) fail("admission_missing");
        budget.remaining();
      }
      busy = true; let attempt;
      try {
        await admitted(); await checkedPath(root);
        attempt = await fs.mkdtemp(path.join(root, ".inspect-")); await fs.chmod(attempt, 0o700);
        const filename = path.join(attempt, "snapshot.bin");
        const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        let count = 0; const hash = crypto.createHash("sha256"), head = Buffer.alloc(32);
        try {
          const observed = await provider.streamSealedObject({ context: { authenticated: true, companyId: task.companyId, userId: task.userId },
            objectKey: task.objectKey, objectVersion: task.objectVersion, consume: async chunk => {
              budget.remaining();
              if ((!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) || chunk.length > 65536 || count + chunk.length > task.sizeBytes) fail("source_invalid");
              if (count < head.length) Buffer.from(chunk).copy(head, count, 0, Math.min(chunk.length, head.length - count));
              hash.update(chunk); count += chunk.length; await handle.writeFile(chunk);
            } });
          if (count !== task.sizeBytes || hash.digest("hex") !== task.sha256 || observed?.sizeBytes !== task.sizeBytes || observed.sha256 !== task.sha256) fail("source_invalid");
          await handle.sync();
        } finally { await handle.close(); }
        await admitted();
        const format = sniff(head, task.mediaKind); let geometry;
        if (task.mediaKind === "image") {
          const bytes = await fs.readFile(filename);
          const settings = { limitInputPixels: LIMITS.imagePixels, failOn: "error" };
          const seconds = () => Math.max(1, Math.min(30, Math.floor(budget.remaining() / 1000)));
          const metadata = await sharp(bytes, settings).timeout({ seconds: seconds() }).metadata();
          if (metadata.format !== format || (metadata.pages || 1) !== 1 || !Number.isSafeInteger(metadata.width) ||
              !Number.isSafeInteger(metadata.height) || metadata.width * metadata.height > LIMITS.imagePixels) fail("image_invalid");
          // Consume the complete decoded raster, not just headers. RGB uchar
          // bounds decoded output to 75 MB at the maximum permitted geometry.
          let decoded = 0;
          const raster = sharp(bytes, settings).timeout({ seconds: seconds() }).removeAlpha().toColourspace("srgb").raw({ depth: "uchar" });
          try {
            for await (const chunk of raster) {
              budget.remaining(); decoded += chunk.length;
              if (decoded > metadata.width * metadata.height * 3) fail("image_invalid");
            }
          } finally { raster.destroy(); }
          if (decoded !== metadata.width * metadata.height * 3) fail("image_invalid");
          geometry = { width: metadata.width, height: metadata.height, frames: 1 };
        } else {
          if (!ffmpegPath) fail("processor_unavailable");
          await checkedPath(ffmpegPath, true);
          const input = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-threads", "2", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", filename];
          async function run(args) {
            await admitted();
            const result = await runBoundedProcess(ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-max_alloc", "67108864", ...args],
              { cwd: attempt, timeoutMs: budget.remaining(), maxOutputBytes: LIMITS.processOutputBytes });
            budget.remaining(); return result;
          }
          const probe = await run(input);
          if (probe.code !== 1 || !/At least one output file must be specified/.test(probe.stderr)) fail("probe_invalid");
          const parsed = parseProbe(probe.stderr, "video");
          const decoded = await run(["-v", "error", "-xerror", ...input, "-map", "0:v:0", "-map", "0:a:0?",
            "-t", String(LIMITS.videoSeconds + 1), "-threads", "2", "-progress", "pipe:1", "-f", "null", "-"]);
          if (decoded.code !== 0 || Math.abs(decodedSeconds(decoded.stdout) - parsed.durationSeconds) > 0.15) fail("decode_invalid");
          geometry = { width: parsed.width, height: parsed.height, durationMs: Math.round(parsed.durationSeconds * 1000),
            hasAudio: parsed.hasAudio, colorMode: "sdr" };
        }
        await admitted();
        const inspection = { complete: true, decoded: true, signatureVerified: true, sizeBytes: count, sha256: task.sha256,
          detectedMime: MIME[format], ...geometry };
        inspectedMedia({ kind: task.mediaKind, format, size: count, sha256: task.sha256, decoded: true,
          ...geometry, durationSeconds: geometry.durationMs / 1000 }, task.mediaKind);
        const finishedAt = clock();
        if (!Number.isSafeInteger(finishedAt) || finishedAt < task.startedAt || finishedAt > task.deadlineAt) fail("deadline_exceeded");
        return { providerType: "render_disk", companyId: task.companyId, userId: task.userId, ticketId: task.ticketId,
          objectKey: task.objectKey, objectVersion: task.objectVersion, executionDigest: task.executionDigest,
          finishedAt, elapsedMs: budget.elapsedMs(), inspection };
      } catch (error) {
        if (/^disk_inspection_[a-z_]{1,60}$/.test(error?.code || "")) fail(error.code.slice("disk_inspection_".length));
        fail("decode_failed");
      } finally {
        try {
          if (attempt) {
            if (path.dirname(attempt) !== root || !path.basename(attempt).startsWith(".inspect-")) fail("cleanup_failed");
            await checkedPath(root); await checkedPath(attempt);
            for (const name of await fs.readdir(attempt)) {
              if (name !== "snapshot.bin") fail("cleanup_failed");
              await checkedPath(path.join(attempt, name), true);
            }
            await fs.rm(attempt, { recursive: true, force: false });
          }
        } catch (_) { fail("cleanup_failed"); }
        finally { busy = false; }
      }
    }
  });
  instances.add(worker); return worker;
}
function isDiskBoundedInspectionWorker(value) { return Boolean(value && instances.has(value)); }
module.exports = { createDiskBoundedInspectionWorker, isDiskBoundedInspectionWorker, validateDiskInspectionTask };
