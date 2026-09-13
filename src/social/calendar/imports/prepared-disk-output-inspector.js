"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), sharp = require("sharp");
const { runBoundedProcess, parseProbe, decodedSeconds } = require("./preparation");
const inspectors = new WeakSet();
function fail() { throw Object.assign(new Error("prepared_disk_inspection_invalid"), { code: "prepared_disk_inspection_invalid" }); }
function parsePreparedOutputProbe(text) {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60.25) fail();
  // Reuse the source codec/stream/geometry parser without relaxing its 60-second
  // source limit. Only a prepared derivative gets the bounded encoder tolerance.
  const checked = parseProbe(text.replace(duration[0], "Duration: 00:00:01.00"), "video");
  return { ...checked, durationSeconds: seconds };
}
function createPreparedDiskOutputInspector({ ffmpegPath, processExecutor, workingDirectory, workflowBridge } = {}) {
  if (workflowBridge !== undefined) {
    if (ffmpegPath !== undefined || processExecutor !== undefined || workingDirectory !== undefined ||
        !require("./workflow-private-transfer").isWorkflowPrivateBridge(workflowBridge)) fail();
    const inspector = Object.freeze({ capabilities: Object.freeze({ actualInspection: true, testOnly: false, imageDecode: true,
      videoDecode: true, remoteReceipt: true }), inspectFile: query => workflowBridge.inspectFile(query) });
    inspectors.add(inspector); return inspector;
  }
  if (ffmpegPath !== undefined && (!path.isAbsolute(ffmpegPath || "") || /^[/\\]{2}/.test(ffmpegPath))) fail();
  if (processExecutor !== undefined && !require("./media-process-executor").isMediaProcessExecutor(processExecutor)) fail();
  if (workingDirectory !== undefined && (!path.isAbsolute(workingDirectory || "") || /^[/\\]{2}/.test(workingDirectory) || /[\0\r\n]/.test(workingDirectory))) fail();
  const inspector = Object.freeze({
    capabilities: Object.freeze({ actualInspection: true, testOnly: false, imageDecode: true, videoDecode: Boolean(ffmpegPath) }),
    async inspectFile({ filePath, descriptor, timeoutMs = 30000 }) {
      if (processExecutor) return processExecutor.inspectPreparedFile({ filePath, descriptor, timeoutMs });
      try {
        if (!path.isAbsolute(filePath || "") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail();
        const start = performance.now(), remaining = () => {
          const value = Math.floor(timeoutMs - (performance.now() - start)); if (value < 1) fail(); return value;
        };
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== descriptor.size ||
            stat.size < 1 || stat.size > (descriptor.mimeType === "image/jpeg" ? 8 : 100) * 1024 ** 2) fail();
        if (descriptor.mimeType === "image/jpeg") {
          const handle = await fs.open(filePath, syncConstants());
          let bytes;
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail();
            bytes = Buffer.alloc(opened.size); let offset = 0;
            while (offset < bytes.length) {
              remaining(); const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
              if (!bytesRead) fail(); offset += bytesRead;
            }
            const after = await handle.stat();
            if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) fail();
          } finally { await handle.close(); }
          if (bytes.length !== stat.size || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) fail();
          const decoder = sharp(bytes, { limitInputPixels: 1080 * 1920, failOn: "error" }).timeout({ seconds: Math.max(1, Math.floor(remaining() / 1000)) });
          const metadata = await decoder.metadata();
          if (metadata.format !== "jpeg" || metadata.exif || metadata.xmp || (metadata.pages || 1) !== 1) fail();
          await decoder.raw().toBuffer(); remaining();
          return { decoded: true, mimeType: "image/jpeg", width: metadata.width, height: metadata.height,
            durationSeconds: null, hasAudio: false };
        }
        if (descriptor.mimeType !== "video/mp4" || !ffmpegPath) fail();
        const executable = await fs.lstat(ffmpegPath);
        if (!executable.isFile() || executable.isSymbolicLink() || path.resolve(await fs.realpath(ffmpegPath)) !== path.resolve(ffmpegPath)) fail();
        const common = ["-hide_banner", "-nostdin", "-nostats", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe",
          "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-threads", "2", "-i", filePath];
        const run = args => runBoundedProcess(ffmpegPath, args, { cwd: workingDirectory || path.dirname(filePath), timeoutMs: remaining(), maxOutputBytes: 262144 });
        const probe = await run(common);
        if (probe.code !== 1 || !/At least one output file must be specified/.test(probe.stderr)) fail();
        const metadata = parsePreparedOutputProbe(probe.stderr);
        if (metadata.rotation !== 0 || metadata.fps !== 30 || !/\bbt709\b/.test(probe.stderr) ||
            metadata.hasAudio && !/Audio: aac\b/.test(probe.stderr)) fail();
        const decode = await run(["-v", "error", "-xerror", ...common, "-map", "0:v:0", "-map", "0:a:0?", "-t", "61",
          "-threads", "2", "-progress", "pipe:1", "-f", "null", "-"]);
        if (decode.code !== 0) fail();
        const end = decodedSeconds(decode.stdout, 60.25);
        if (end > 60.25 || Math.abs(end - metadata.durationSeconds) > 0.25) fail();
        remaining();
        return { decoded: true, mimeType: "video/mp4", width: metadata.width, height: metadata.height,
          durationSeconds: metadata.durationSeconds, hasAudio: metadata.hasAudio, videoCodec: "h264",
          audioCodec: metadata.hasAudio ? "aac" : null, color: "bt709", fps: 30 };
      } catch (_) { fail(); }
    }
  });
  inspectors.add(inspector); return inspector;
}
function isPreparedDiskOutputInspector(value) { return Boolean(value && inspectors.has(value)); }
function syncConstants() { const constants = require("node:fs").constants; return constants.O_RDONLY | (constants.O_NOFOLLOW || 0); }
module.exports = { createPreparedDiskOutputInspector, isPreparedDiskOutputInspector, parsePreparedOutputProbe };
