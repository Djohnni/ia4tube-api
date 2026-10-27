"use strict";

const fs = require("node:fs/promises"), { constants } = require("node:fs");
const path = require("node:path"), crypto = require("node:crypto"), sharp = require("sharp");
const { runBoundedProcess, decodedSeconds, sniff, createPreparationDeadline } = require("./preparation");

// Explicit opt-in for already compatible files. This is not a conversion profile:
// the inspected MP4 bytes, original audio, frame rate and colour tags are retained.
const NATIVE_READY_VIDEO_PROFILE = "native_mp4_v1";
const NATIVE_METADATA_FIELDS = Object.freeze(["nativeProfile", "frameRate", "pixelFormat", "colorTransfer", "colorPrimaries", "colorRange", "audioSampleRate", "audioChannels"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_BYTES = 100 * 1024 ** 2;
const RATES = new Set(["24/1", "25/1", "30/1", "50/1", "60/1", "24000/1001", "30000/1001", "60000/1001"]);
const COLORS = new Set(["bt709", "smpte170m", "bt470bg"]);
const TRANSFERS = new Set(["bt709", "smpte170m", "iec61966-2-1", "gamma22", "gamma28"]);
function fail(code = "invalid") { throw Object.assign(new Error("Vídeo pronto incompatível ou não confirmado."), { code: `native_ready_video_${code}`, statusCode: 422 }); }
function rational(value) {
  const found = /^(\d+)\/(\d+)$/.exec(String(value || ""));
  if (!found) fail("frame_rate_invalid");
  let a = Number(found[1]), b = Number(found[2]);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1) fail("frame_rate_invalid");
  let x = a, y = b; while (y) { const next = x % y; x = y; y = next; }
  return `${a / x}/${b / x}`;
}
function fpsFor(rate) { const [a, b] = rate.split("/").map(Number); return a / b; }
function isNativeReadyVideoMetadata(value) {
  return Boolean(value && value.nativeProfile === NATIVE_READY_VIDEO_PROFILE && value.mimeType === "video/mp4" &&
    value.width === 1080 && value.height === 1920 && value.videoCodec === "h264" &&
    Number.isFinite(value.durationSeconds) && value.durationSeconds >= 3 && value.durationSeconds <= 60 &&
    RATES.has(value.frameRate) && value.fps === fpsFor(value.frameRate) &&
    ["yuv420p", "yuvj420p"].includes(value.pixelFormat) && COLORS.has(value.color) &&
    COLORS.has(value.colorPrimaries) && TRANSFERS.has(value.colorTransfer) && ["tv", "pc", "unknown"].includes(value.colorRange) &&
    typeof value.hasAudio === "boolean" && (value.hasAudio
      ? value.audioCodec === "aac" && [44100, 48000].includes(value.audioSampleRate) && [1, 2].includes(value.audioChannels)
      : value.audioCodec === null && value.audioSampleRate === null && value.audioChannels === null));
}
function parseNativeReadyVideoProbe(probe) {
  if (!probe || !Array.isArray(probe.streams) || probe.streams.length < 1 || probe.streams.length > 2 ||
      probe.streams.some(stream => !stream || typeof stream !== "object") ||
      typeof probe.format?.format_name !== "string" || !probe.format.format_name.split(",").includes("mp4")) fail("probe_invalid");
  const videos = probe.streams.filter(stream => stream.codec_type === "video"), audios = probe.streams.filter(stream => stream.codec_type === "audio");
  if (videos.length !== 1 || audios.length > 1 || videos.length + audios.length !== probe.streams.length) fail("streams_invalid");
  const video = videos[0], audio = audios[0], frameRate = rational(video.avg_frame_rate);
  // With no SAR signalled, the intrinsic 1080x1920 geometry uses square pixels.
  // An explicit anamorphic ratio still requires conversion and is not accepted.
  if (rational(video.r_frame_rate) !== frameRate || ![undefined, "N/A", "1:1"].includes(video.sample_aspect_ratio) ||
      ![undefined, "progressive", "unknown"].includes(video.field_order) ||
      Number(video.tags?.rotate || 0) !== 0 || video.side_data_list !== undefined && !Array.isArray(video.side_data_list) ||
      (video.side_data_list || []).some(side => !side || side.rotation !== undefined && Number(side.rotation) !== 0)) fail("geometry_invalid");
  const durationSeconds = Number(probe.format.duration);
  const result = { nativeProfile: NATIVE_READY_VIDEO_PROFILE, decoded: false, mimeType: "video/mp4",
    width: video.width, height: video.height, durationSeconds, hasAudio: Boolean(audio), videoCodec: video.codec_name,
    audioCodec: audio?.codec_name || null, audioSampleRate: audio ? Number(audio.sample_rate) : null,
    audioChannels: audio?.channels ?? null, color: video.color_space, colorTransfer: video.color_transfer,
    colorPrimaries: video.color_primaries, colorRange: video.color_range || "unknown", pixelFormat: video.pix_fmt,
    frameRate, fps: fpsFor(frameRate) };
  if (!isNativeReadyVideoMetadata(result) || [video, audio].filter(Boolean).some(stream =>
    stream.duration !== undefined && (!Number.isFinite(Number(stream.duration)) || Number(stream.duration) <= 0 ||
      Math.abs(Number(stream.duration) - durationSeconds) > 0.25))) fail("profile_incompatible");
  return Object.freeze(result);
}
function localPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /^[/\\]{2}/.test(value) || /[\0\r\n]/.test(value) ||
      value.replace(/^[a-z]:/i, "").includes(":")) fail("path_invalid");
  return path.resolve(value);
}
async function noLinks(value, file = false) {
  const absolute = localPath(value), root = path.parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) fail("path_invalid");
  }
  const stat = await fs.lstat(absolute);
  if (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) fail("path_invalid");
  return stat;
}
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
async function readDigest(filename, check, destination) {
  const before = await noLinks(filename, true);
  if (before.size < 16 || before.size > MAX_BYTES) fail("size_invalid");
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const digest = crypto.createHash("sha256"), buffer = Buffer.alloc(65536); let offset = 0;
  try {
    const opened = await handle.stat(); if (identity(opened) !== identity(before) || opened.nlink !== 1) fail("source_changed");
    while (offset < before.size) {
      check(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) fail("source_changed"); const bytes = buffer.subarray(0, bytesRead);
      if (offset === 0 && sniff(bytes, "video") !== "mp4") fail("container_invalid");
      digest.update(bytes); if (destination) await destination.writeFile(bytes); offset += bytesRead;
    }
    check(); const after = await handle.stat(), named = await fs.lstat(filename);
    if (after.nlink !== 1 || named.isSymbolicLink() || identity(after) !== identity(before) || identity(named) !== identity(before)) fail("source_changed");
    return { sha256: digest.digest("hex"), size: before.size, identity: identity(before) };
  } finally { await handle.close(); }
}
function budget(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) fail("budget_invalid");
  const start = performance.now(); return () => { const left = Math.floor(timeoutMs - (performance.now() - start)); if (left < 1) fail("timeout"); return left; };
}
function codecRunner(codecExecutor, runProcess, onCodecStart, onCodecResult) {
  if (codecExecutor !== undefined && !require("./ready-video-codec-executor").isReadyVideoCodecExecutor(codecExecutor)) fail("executor_invalid");
  if (typeof runProcess !== "function" || onCodecStart !== undefined && typeof onCodecStart !== "function" ||
      onCodecResult !== undefined && typeof onCodecResult !== "function") fail("executor_invalid");
  return async (operation, inputPath, outputPath, binary, args, options) => {
    if (onCodecStart) await onCodecStart();
    let result;
    try {
      result = await (codecExecutor
        ? codecExecutor.run({ operation, inputPath, ...(outputPath ? { outputPath } : {}), timeoutMs: Math.min(options.timeoutMs, 30000) })
        : runProcess(binary, args, options));
    } catch (error) {
      if (onCodecResult) await onCodecResult(error);
      if (codecExecutor && !terminationConfirmed(error)) fail("termination_unconfirmed");
      throw error;
    }
    if (onCodecResult) await onCodecResult(result);
    if (codecExecutor && !terminationConfirmed(result)) fail("termination_unconfirmed");
    return result;
  };
}
function terminationConfirmed(result) {
  return result?.termination?.proved === true && result.termination.descendants === 0 && /^[a-f0-9]{64}$/.test(result.termination.proofId || "");
}
async function inspectNativeReadyVideo({ filePath, ffmpegPath, ffprobePath, timeoutMs = 30000,
  codecExecutor, runProcess = runBoundedProcess, onCodecStart, onCodecResult } = {}) {
  const remaining = budget(timeoutMs); filePath = localPath(filePath);
  const run = codecRunner(codecExecutor, runProcess, onCodecStart, onCodecResult);
  if (!codecExecutor) { await noLinks(ffmpegPath, true); await noLinks(ffprobePath, true); }
  const before = await readDigest(filePath, remaining);
  const input = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0"];
  const probe = await run("probe", filePath, null, ffprobePath, ["-v", "error", "-max_alloc", "67108864", ...input,
    "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,field_order,color_range,color_space,color_transfer,color_primaries,duration,sample_rate,channels:stream_side_data=rotation:stream_tags=rotate:format=duration,format_name",
    "-of", "json", filePath], { cwd: path.dirname(filePath), timeoutMs: remaining(), maxOutputBytes: 65536 });
  let metadata; try { if (probe.code !== 0) fail(); metadata = parseNativeReadyVideoProbe(JSON.parse(probe.stdout)); } catch { fail("probe_invalid"); }
  const decode = await run("decode", filePath, null, ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-v", "error", "-xerror", "-max_alloc", "67108864",
    ...input, "-threads", "2", "-i", filePath, "-map", "0:v:0", "-map", "0:a:0?", "-t", "61", "-threads", "2", "-progress", "pipe:1", "-f", "null", "-"],
    { cwd: path.dirname(filePath), timeoutMs: remaining(), maxOutputBytes: 262144 });
  let decodedEnd; try { if (decode.code !== 0) fail(); decodedEnd = decodedSeconds(decode.stdout, 60); } catch { fail("decode_invalid"); }
  if (Math.abs(decodedEnd - metadata.durationSeconds) > 0.25) fail("duration_invalid");
  const after = await readDigest(filePath, remaining);
  if (after.sha256 !== before.sha256 || after.identity !== before.identity) fail("source_changed");
  return Object.freeze({ ...metadata, decoded: true, sha256: after.sha256, size: after.size });
}
async function ensurePrivateDirectory(value) {
  await fs.mkdir(value, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await noLinks(value);
  if (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid())) fail("directory_unsafe");
}
function createNativeReadyVideoPreparer({ inputRoot, outputRoot, ffmpegPath, ffprobePath, maxPreparationMs = 180000, clock = Date.now,
  codecExecutor, runProcess = runBoundedProcess, onCodecStart, onCodecResult } = {}) {
  inputRoot = localPath(inputRoot); outputRoot = localPath(outputRoot);
  if (!codecExecutor) { ffmpegPath = localPath(ffmpegPath); ffprobePath = localPath(ffprobePath); }
  const run = codecRunner(codecExecutor, runProcess, onCodecStart, onCodecResult);
  if (inputRoot === outputRoot) fail("configuration_invalid");
  let busy = false;
  return Object.freeze({ async prepare(spec, { deadlineAt } = {}) {
    if (busy) fail("busy");
    if (!spec || !UUID.test(spec.companyId || "") || !UUID.test(spec.assetId || "") ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(spec.sourceName || "") || spec.sourceName.includes("..") ||
        spec.kind !== "video" || !Array.isArray(spec.targets) || !spec.targets.length || spec.targets.length > 2 ||
        new Set(spec.targets).size !== spec.targets.length || spec.targets.some(target => !["reel", "story"].includes(target)) ||
        spec.audioMode !== "original" || spec.musicTrackId !== undefined && spec.musicTrackId !== null ||
        spec.musicalTargets !== undefined && (!Array.isArray(spec.musicalTargets) || spec.musicalTargets.length)) fail("selection_invalid");
    const timing = createPreparationDeadline({ maxRuntimeMs: maxPreparationMs, deadlineAt, clock });
    const remaining = timing.remaining; let attempt, retainAttempt = false; busy = true;
    try {
      await noLinks(inputRoot); await noLinks(outputRoot);
      if (!codecExecutor) { await noLinks(ffmpegPath, true); await noLinks(ffprobePath, true); }
      const ownerDir = path.join(outputRoot, spec.companyId), assetDir = path.join(ownerDir, spec.assetId);
      await ensurePrivateDirectory(ownerDir); await ensurePrivateDirectory(assetDir);
      attempt = await fs.mkdtemp(path.join(assetDir, ".native-")); await fs.chmod(attempt, 0o700);
      const snapshot = path.join(attempt, "source.mp4"), handle = await fs.open(snapshot, "wx", 0o600);
      let original; try { original = await readDigest(path.join(inputRoot, spec.companyId, spec.sourceName), remaining, handle); await handle.sync(); } finally { await handle.close(); }
      const inspected = await inspectNativeReadyVideo({ filePath: snapshot, ffmpegPath, ffprobePath, codecExecutor, runProcess,
        onCodecStart, onCodecResult, timeoutMs: remaining() });
      if (inspected.sha256 !== original.sha256 || inspected.size !== original.size) fail("source_changed");
      const frame = path.join(attempt, "frame.jpg");
      const extracted = await run("thumbnail", snapshot, frame, ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-v", "error", "-xerror", "-max_alloc", "67108864",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-threads", "2", "-i", snapshot,
        "-map", "0:v:0", "-frames:v", "1", "-an", "-map_metadata", "-1", "-threads", "2", "-f", "image2", "-n", frame],
        { cwd: attempt, timeoutMs: remaining(), maxOutputBytes: 65536 });
      if (extracted.code !== 0 || (await noLinks(frame, true)).size > 8 * 1024 ** 2) fail("thumbnail_invalid");
      const thumbnailBytes = await sharp(await fs.readFile(frame), { limitInputPixels: 1080 * 1920, failOn: "error" })
        .timeout({ seconds: Math.max(1, Math.floor(remaining() / 1000)) }).toColourspace("srgb").jpeg({ quality: 85 }).toBuffer();
      const thumbnailInfo = await sharp(thumbnailBytes).metadata();
      if (thumbnailInfo.width !== 1080 || thumbnailInfo.height !== 1920 || thumbnailBytes.length > 8 * 1024 ** 2) fail("thumbnail_invalid");
      async function install(source, bytes, sha256, extension) {
        remaining(); const filename = `${sha256}.${extension}`, destination = path.join(assetDir, filename);
        let created = false;
        try {
          if (source) await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
          else await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
          created = true;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const existing = await noLinks(destination, true);
          if (existing.size !== (source ? inspected.size : bytes.length)) fail("output_conflict");
        }
        if (extension === "mp4") { const checked = await readDigest(destination, remaining); if (checked.sha256 !== sha256) fail("output_conflict"); }
        else if (crypto.createHash("sha256").update(await fs.readFile(destination)).digest("hex") !== sha256) fail("output_conflict");
        if (created) { const sync = await fs.open(destination, "r+"); try { await sync.sync(); } finally { await sync.close(); } }
        await fs.chmod(destination, 0o400);
        return filename;
      }
      const { decoded, sha256, size, ...metadata } = inspected;
      const video = Object.freeze({ ...metadata, sourceSha256: sha256, sha256, size, audioMode: "original",
        fileName: await install(snapshot, null, sha256, "mp4") });
      const thumbnailSha = crypto.createHash("sha256").update(thumbnailBytes).digest("hex");
      const thumbnail = Object.freeze({ mimeType: "image/jpeg", width: 1080, height: 1920, sourceSha256: sha256,
        sha256: thumbnailSha, size: thumbnailBytes.length, durationSeconds: null, audioMode: "none", hasAudio: false,
        fileName: await install(null, thumbnailBytes, thumbnailSha, "jpg") });
      remaining();
      return Object.freeze({ sourceSha256: sha256, sourceSize: size, sourceKind: "video",
        sourceInspection: Object.freeze({ kind: "video", format: "mp4", decoded: true, sha256, size, width: 1080, height: 1920,
          durationSeconds: Math.round(inspected.durationSeconds * 1000) / 1000, hasAudio: inspected.hasAudio, colorMode: "sdr" }),
        variants: Object.freeze(Object.fromEntries(spec.targets.map(target => [target, video]))), thumbnail,
        commercialReady: true, elapsedMs: timing.elapsedMs(), policy: NATIVE_READY_VIDEO_PROFILE });
    } catch (error) {
      if (error?.code === "native_ready_video_termination_unconfirmed") retainAttempt = true;
      if (/^native_ready_video_[a-z_]+$/.test(error?.code || "")) throw error;
      fail("preparation_failed");
    } finally {
      try {
        if (attempt && !retainAttempt) {
          const relative = path.relative(outputRoot, attempt);
          if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(attempt).startsWith(".native-")) fail("cleanup_failed");
          await noLinks(attempt); await fs.rm(attempt, { recursive: true, force: true });
        }
      } finally { busy = false; }
    }
  } });
}
module.exports = { NATIVE_READY_VIDEO_PROFILE, NATIVE_METADATA_FIELDS, isNativeReadyVideoMetadata,
  parseNativeReadyVideoProbe, inspectNativeReadyVideo, createNativeReadyVideoPreparer };
