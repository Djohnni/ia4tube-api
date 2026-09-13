"use strict";
// Raw decoder called only in the fixed supervised child, over its already
// verified private source snapshot. No second full-size source copy is made.
const fs = require("node:fs/promises"), path = require("node:path"), sharp = require("sharp");
const { validateDiskInspectionTask } = require("./disk-inspection-worker");
const { LIMITS, sniff, createPreparationDeadline, runBoundedProcess, parseProbe, decodedSeconds } = require("./preparation");
const { inspectedMedia } = require("./policy");
async function inspectSnapshot({ task, sourcePath, ffmpegPath, clock, timeoutMs }) {
  validateDiskInspectionTask(task);
  const budget = createPreparationDeadline({ clock, maxRuntimeMs: timeoutMs, deadlineAt: task.deadlineAt }), head = Buffer.alloc(32), handle = await fs.open(sourcePath, "r");
  try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
  const format = sniff(head, task.mediaKind); let geometry;
  if (task.mediaKind === "image") {
    const bytes = await fs.readFile(sourcePath), settings = { limitInputPixels: LIMITS.imagePixels, failOn: "error" };
    const seconds = () => Math.max(1, Math.min(30, Math.floor(budget.remaining() / 1000)));
    const metadata = await sharp(bytes, settings).timeout({ seconds: seconds() }).metadata();
    if (metadata.format !== format || (metadata.pages || 1) !== 1 || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width * metadata.height > LIMITS.imagePixels) throw Error("image_invalid");
    let count = 0; const raster = sharp(bytes, settings).timeout({ seconds: seconds() }).removeAlpha().toColourspace("srgb").raw({ depth: "uchar" });
    try { for await (const chunk of raster) { budget.remaining(); count += chunk.length; if (count > metadata.width * metadata.height * 3) throw Error("image_invalid"); } } finally { raster.destroy(); }
    if (count !== metadata.width * metadata.height * 3) throw Error("image_invalid");
    geometry = { width: metadata.width, height: metadata.height, frames: 1 };
  } else {
    const input = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-threads", "2", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", sourcePath];
    const run = args => runBoundedProcess(ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-max_alloc", "67108864", ...args], { cwd: path.dirname(sourcePath), timeoutMs: budget.remaining(), maxOutputBytes: LIMITS.processOutputBytes });
    const probe = await run(input); if (probe.code !== 1 || !/At least one output file must be specified/.test(probe.stderr)) throw Error("probe_invalid");
    const metadata = parseProbe(probe.stderr, "video"), decoded = await run(["-v", "error", "-xerror", ...input, "-map", "0:v:0", "-map", "0:a:0?", "-t", "61", "-threads", "2", "-progress", "pipe:1", "-f", "null", "-"]);
    if (decoded.code !== 0 || Math.abs(decodedSeconds(decoded.stdout) - metadata.durationSeconds) > 0.15) throw Error("decode_invalid");
    geometry = { width: metadata.width, height: metadata.height, durationMs: Math.round(metadata.durationSeconds * 1000), hasAudio: metadata.hasAudio, colorMode: "sdr" };
  }
  budget.remaining();
  inspectedMedia({ kind: task.mediaKind, format, size: task.sizeBytes, sha256: task.sha256, decoded: true, ...geometry, durationSeconds: geometry.durationMs / 1000 }, task.mediaKind);
  return { providerType: "render_disk", companyId: task.companyId, userId: task.userId, ticketId: task.ticketId, objectKey: task.objectKey,
    objectVersion: task.objectVersion, executionDigest: task.executionDigest, finishedAt: clock(), elapsedMs: budget.elapsedMs(),
    inspection: { complete: true, decoded: true, signatureVerified: true, sizeBytes: task.sizeBytes, sha256: task.sha256,
      detectedMime: { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime" }[format], ...geometry } };
}
module.exports = { inspectSnapshot };
