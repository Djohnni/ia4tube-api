"use strict";

// Local preparation boundary for iA4tube. It does not publish, fetch URLs, spend
// creation credits, manage a queue, or grant ownership. The caller must resolve
// the authenticated company and immutable, completed upload before calling it.
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const sharp = require("sharp");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.(?:jpg|jpeg|png|webp|mp4|mov|wav|mp3)$/;
const LIMITS = Object.freeze({ imageBytes: 32 * 1024 * 1024, imagePixels: 25000000,
  videoBytes: 100 * 1024 * 1024, videoPixels: 8294400, videoSeconds: 60,
  musicBytes: 32 * 1024 * 1024, musicSeconds: 600, musicalSeconds: 15, jpegBytes: 8 * 1024 * 1024,
  outputBytes: 100 * 1024 * 1024, processTimeoutMs: 180000, processOutputBytes: 256 * 1024 });

function fault(code) { const e = new Error(code); e.code = code; return e; }
function requireThat(condition, code) { if (!condition) throw fault(code); }
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// One budget shared by all preparation stages. Monotonic elapsed time prevents
// a wall-clock adjustment from granting more execution time. This is cooperative
// enforcement; the remote worker must additionally enforce a total OS/task bound.
function createPreparationDeadline({ clock = Date.now, monotonicClock = () => performance.now(),
  maxRuntimeMs = LIMITS.processTimeoutMs, deadlineAt } = {}) {
  requireThat(Number.isSafeInteger(maxRuntimeMs) && maxRuntimeMs > 0 &&
    maxRuntimeMs <= LIMITS.processTimeoutMs, "media_budget_invalid");
  const startedAt = clock();
  const monotonicStart = monotonicClock();
  requireThat(Number.isSafeInteger(startedAt) && startedAt >= 0 && Number.isFinite(monotonicStart) &&
    (deadlineAt === undefined || Number.isSafeInteger(deadlineAt)), "media_budget_invalid");
  const expiresAt = Math.min(deadlineAt ?? startedAt + maxRuntimeMs, startedAt + maxRuntimeMs);
  const budgetMs = expiresAt - startedAt;
  requireThat(budgetMs > 0, "media_task_deadline_exceeded");
  let lastMonotonic = monotonicStart;
  function monotonicNow() {
    const value = monotonicClock();
    requireThat(Number.isFinite(value) && value >= lastMonotonic, "media_budget_invalid");
    lastMonotonic = value;
    return value;
  }
  return Object.freeze({ remaining() {
    const now = clock(), monotonic = monotonicNow();
    requireThat(Number.isSafeInteger(now) && now >= 0, "media_budget_invalid");
    const remaining = Math.floor(Math.min(expiresAt - now, budgetMs - (monotonic - monotonicStart)));
    requireThat(remaining > 0, "media_task_deadline_exceeded");
    return remaining;
  }, elapsedMs() { return Math.ceil(monotonicNow() - monotonicStart); } });
}

function assertLocalPath(value) {
  requireThat(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") &&
    !/[\r\n]/.test(value) && !/^[/\\]{2}/.test(value) && !/^[a-z]+:\/\//i.test(value), "media_path_invalid");
  // An absolute Windows drive is allowed; alternate data streams are not.
  requireThat(!value.replace(/^[a-z]:/i, "").includes(":"), "media_path_invalid");
  return path.resolve(value);
}

async function assertNoLinks(value, requireFile = false) {
  const absolute = assertLocalPath(value);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current);
    requireThat(!stat.isSymbolicLink(), "media_link_forbidden");
  }
  const stat = await fsp.lstat(absolute);
  requireThat(requireFile ? stat.isFile() : stat.isDirectory(), "media_path_invalid");
  return stat;
}

function under(root, ...parts) {
  const result = path.resolve(root, ...parts);
  const relative = path.relative(root, result);
  requireThat(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), "media_path_invalid");
  return result;
}

// Injectable process boundary. No shell, no inherited API secrets, bounded logs,
// timeout and ffmpeg allocation/thread/file bounds. These are not an OS sandbox:
// production must additionally run in a credential-free, memory/disk-limited worker.
function runBoundedProcess(binary, args, { cwd, timeoutMs = LIMITS.processTimeoutMs,
  maxOutputBytes = LIMITS.processOutputBytes, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let outputSize = 0;
    const stdout = [];
    const stderr = [];
    let stopReason;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    try {
      const environment = { LANG: "C", LC_ALL: "C" };
      if (process.platform === "win32" && process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
      child = spawnProcess(binary, args, { cwd, shell: false, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"], env: environment });
      // Register before accessing stdio: Windows may reject a long/invalid cwd
      // and emit an asynchronous spawn error without creating pipe streams.
      child.on("error", () => finish(fault("media_processor_unavailable")));
      const stop = code => { if (!stopReason) { stopReason = code; child.kill("SIGKILL"); } };
      timer = setTimeout(() => stop("media_process_timeout"), timeoutMs);
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
        stream.on("data", chunk => {
          outputSize += chunk.length;
          if (outputSize > maxOutputBytes) return stop("media_process_output_limit");
          chunks.push(chunk);
        });
      }
      child.on("close", code => finish(stopReason ? fault(stopReason) : null,
        { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    } catch (_) { finish(fault("media_processor_unavailable")); }
  });
}

function sniff(bytes, kind) {
  if (kind === "image") {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  } else if (kind === "video") {
    if (bytes.length >= 16 && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= 4096 &&
      bytes.toString("ascii", 4, 8) === "ftyp" && /^(?:isom|iso[2-9]|mp4[12]|avc1|qt  |M4V )$/.test(bytes.toString("ascii", 8, 12))) {
      return bytes.toString("ascii", 8, 12) === "qt  " ? "mov" : "mp4";
    }
  } else if (kind === "music") {
    if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "wav";
    if (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 &&
      (bytes[1] & 0x18) !== 0x08 && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0xf0) !== 0x00)) return "mp3";
  }
  throw fault("media_signature_unsupported");
}

function parseProbe(text, kind) {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  requireThat(duration, "media_duration_unverified");
  const durationSeconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  requireThat(durationSeconds > 0 && durationSeconds <= (kind === "music" ? LIMITS.musicSeconds : LIMITS.videoSeconds), "media_duration_invalid");
  const streams = text.split(/\r?\n/).filter(line => /^\s*Stream #0:\d+/.test(line));
  const videos = streams.filter(line => line.includes("Video:"));
  const audios = streams.filter(line => line.includes("Audio:"));
  requireThat(streams.length === videos.length + audios.length && audios.length <= 1,
    "media_streams_unsupported");
  if (kind === "music") {
    requireThat(videos.length === 0 && audios.length === 1 && /Audio: (?:pcm_s16le|mp3)\b/.test(audios[0]), "media_music_format_unsupported");
    return { durationSeconds, hasAudio: true };
  }
  requireThat(videos.length === 1 && /Video: h264\b/.test(videos[0]), "media_video_codec_unsupported");
  requireThat(!/smpte2084|arib-std-b67|bt2020|yuv\w*p(?:10|12|16)|gbrp|rgb24/i.test(text) &&
    /\byuvj?420p\b/.test(videos[0]), "media_video_color_unsupported");
  if (audios.length) requireThat(/Audio: (?:aac|pcm_s16le|pcm_s24le)\b/.test(audios[0]), "media_audio_codec_unsupported");
  const geometry = /(?:,\s*|\s)(\d{2,5})x(\d{2,5})(?:[\s,\[])/.exec(videos[0]);
  const rate = /(?:,|\s)(\d+(?:\.\d+)?) fps\b/.exec(videos[0]);
  requireThat(geometry && rate, "media_geometry_unverified");
  const width = Number(geometry[1]);
  const height = Number(geometry[2]);
  const fps = Number(rate[1]);
  requireThat(width <= 4096 && height <= 4096 && width * height <= LIMITS.videoPixels && fps > 0 && fps <= 60,
    "media_video_geometry_invalid");
  const rotationMatch = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(text);
  const rotation = rotationMatch ? Number(rotationMatch[1]) : 0;
  requireThat([0, 90, -90, 180, -180, 270, -270].includes(rotation), "media_rotation_unsupported");
  return { width, height, fps, rotation, durationSeconds, hasAudio: audios.length === 1 };
}

function decodedSeconds(progress, maxSeconds = LIMITS.videoSeconds) {
  requireThat(/(?:^|\n)progress=end(?:\r?\n|$)/.test(progress), "media_decode_incomplete");
  const values = [...progress.matchAll(/(?:^|\n)out_time_us=(-?\d+)/g)].map(match => Number(match[1]) / 1000000);
  requireThat(values.length && values.every(Number.isFinite), "media_duration_unverified");
  const seconds = Math.max(...values);
  requireThat(seconds > 0 && seconds <= maxSeconds + 0.05, "media_duration_invalid");
  return seconds;
}

function validateSpec(spec) {
  requireThat(spec && UUID.test(spec.companyId) && UUID.test(spec.assetId) && NAME.test(spec.sourceName), "media_request_invalid");
  requireThat(["image", "video"].includes(spec.kind) && Array.isArray(spec.targets) && spec.targets.length > 0 &&
    spec.targets.length <= 3 && new Set(spec.targets).size === spec.targets.length &&
    spec.targets.every(target => ["feed", "story", "reel"].includes(target)), "media_targets_invalid");
  const audioMode = spec.audioMode || (spec.kind === "video" ? "original" : "none");
  const musicalTargets = spec.musicalTargets || [];
  requireThat(Array.isArray(musicalTargets) && new Set(musicalTargets).size === musicalTargets.length &&
    musicalTargets.every(target => ["story", "reel"].includes(target) && spec.targets.includes(target)), "media_music_targets_invalid");
  if (spec.kind === "video") {
    requireThat(["original", "muted"].includes(audioMode) && !spec.targets.includes("feed") &&
      !musicalTargets.length && !spec.musicTrackId, "media_video_options_invalid");
  } else {
    requireThat(["none", "music"].includes(audioMode), "media_image_options_invalid");
    requireThat(audioMode === "music" ? typeof spec.musicTrackId === "string" &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(spec.musicTrackId) && musicalTargets.length > 0 :
      !spec.musicTrackId && musicalTargets.length === 0, "media_music_options_invalid");
    requireThat(!spec.targets.includes("reel") || musicalTargets.includes("reel"), "media_reel_requires_video");
  }
  return { ...spec, audioMode, musicalTargets };
}

/**
 * Prepare an already-owned immutable upload using local files only.
 * Input: inputRoot/companyId/sourceName. Output: outputRoot/companyId/assetId.
 * No directories, credentials, MIME or license values are accepted from an end
 * user beyond the validated spec. resolveMusicTrack is a trusted catalog adapter:
 * { sourceName: 'approved.wav|mp3', rights: { commercialPublishing: true, evidenceId } }.
 * Synthetic tracks require allowSyntheticAudio=true and produce commercialReady=false.
 * A caller must not activate scheduling/publication while commercialReady=false.
 */
function createImportMediaPreparer({ inputRoot, outputRoot, ffmpegPath, musicRoot,
  resolveMusicTrack, allowSyntheticAudio = false, processRunner = runBoundedProcess,
  clock = Date.now, monotonicClock = () => performance.now(), maxPreparationMs = LIMITS.processTimeoutMs } = {}) {
  inputRoot = assertLocalPath(inputRoot);
  outputRoot = assertLocalPath(outputRoot);
  if (ffmpegPath) ffmpegPath = assertLocalPath(ffmpegPath);
  if (musicRoot) musicRoot = assertLocalPath(musicRoot);
  let busy = false;
  let activeBudget;
  const remaining = () => activeBudget.remaining();
  const imageTimeoutSeconds = () => Math.max(1, Math.min(30, Math.floor(remaining() / 1000)));

  async function run(args, cwd) {
    requireThat(ffmpegPath, "media_processor_unavailable");
    await assertNoLinks(ffmpegPath, true);
    const result = await processRunner(ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-max_alloc", "67108864", ...args],
      { cwd, timeoutMs: Math.min(LIMITS.processTimeoutMs, remaining()), maxOutputBytes: LIMITS.processOutputBytes });
    remaining();
    return result;
  }
  function inputArgs(file, format) {
    return ["-protocol_whitelist", "file,pipe", "-format_whitelist", format, "-threads", "2",
      ...(format === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []), "-i", file];
  }
  async function probe(file, format, kind, cwd) {
    const result = await run([...inputArgs(file, format)], cwd);
    requireThat(result.code === 1 && /At least one output file must be specified/.test(result.stderr), "media_probe_failed");
    return parseProbe(result.stderr, kind);
  }
  async function decode(file, format, kind, cwd) {
    const maxSeconds = kind === "music" ? LIMITS.musicSeconds : LIMITS.videoSeconds;
    const result = await run(["-v", "error", "-xerror", ...inputArgs(file, format),
      "-map", kind === "music" ? "0:a:0" : "0:v:0", ...(kind === "music" ? [] : ["-map", "0:a:0?"]),
      "-t", String(maxSeconds + 1), "-threads", "2", "-progress", "pipe:1", "-f", "null", "-"], cwd);
    requireThat(result.code === 0, "media_decode_failed");
    return decodedSeconds(result.stdout, maxSeconds);
  }
  async function snapshot(source, dest, maxBytes, kind) {
    remaining();
    const stat = await assertNoLinks(source, true);
    requireThat(stat.size > 0 && stat.size <= maxBytes, "media_size_invalid");
    // The upload is snapshotted privately; ffmpeg never follows a mutable upload
    // filename. readFile is bounded by the opened descriptor's stat and read loop.
    const sourceFd = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const targetFd = await fsp.open(dest, "wx", 0o600);
    let read = 0;
    const digest = crypto.createHash("sha256");
    const head = Buffer.alloc(32);
    try {
      const actual = await sourceFd.stat();
      requireThat(actual.isFile() && actual.size === stat.size, "media_source_changed");
      const buffer = Buffer.alloc(256 * 1024);
      for (;;) {
        remaining();
        const { bytesRead } = await sourceFd.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        requireThat(read + bytesRead <= maxBytes, "media_size_invalid");
        if (read === 0) buffer.copy(head, 0, 0, Math.min(head.length, bytesRead));
        digest.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await targetFd.write(buffer, written, bytesRead - written);
          requireThat(result.bytesWritten > 0, "media_snapshot_failed");
          written += result.bytesWritten;
        }
        read += bytesRead;
      }
      const after = await sourceFd.stat();
      requireThat(read === stat.size && after.size === actual.size && after.mtimeMs === actual.mtimeMs, "media_source_changed");
      await targetFd.sync();
    } finally { await sourceFd.close(); await targetFd.close(); }
    return { sha256: digest.digest("hex"), size: read, format: sniff(head, kind) };
  }
  async function commitFile(tempFile, assetDir, descriptor) {
    remaining();
    const stat = await assertNoLinks(tempFile, true);
    const maximum = descriptor.mimeType === "image/jpeg" ? LIMITS.jpegBytes : LIMITS.outputBytes;
    requireThat(stat.size > 0 && stat.size <= maximum, "media_output_size_invalid");
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(tempFile)) { remaining(); hash.update(chunk); }
    const sha256 = hash.digest("hex");
    const fileName = `${sha256}.${descriptor.mimeType === "image/jpeg" ? "jpg" : "mp4"}`;
    const target = under(assetDir, fileName);
    try { await fsp.copyFile(tempFile, target, fs.constants.COPYFILE_EXCL); await fsp.chmod(target, 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const present = await assertNoLinks(target, true);
      requireThat(present.size === stat.size, "media_output_conflict");
      const current = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(target)) current.update(chunk);
      requireThat(current.digest("hex") === sha256, "media_output_conflict");
    }
    remaining();
    return Object.freeze({ ...descriptor, fileName, sha256, size: stat.size });
  }

  async function prepare(request, { deadlineAt } = {}) {
    const spec = validateSpec(request);
    requireThat(!busy, "media_preparer_busy");
    const budget = createPreparationDeadline({ clock, monotonicClock, maxRuntimeMs: maxPreparationMs, deadlineAt });
    busy = true;
    activeBudget = budget;
    let attempt;
    try {
      await assertNoLinks(inputRoot);
      await assertNoLinks(outputRoot);
      const companyInput = under(inputRoot, spec.companyId);
      await assertNoLinks(companyInput);
      const companyOutput = under(outputRoot, spec.companyId);
      await fsp.mkdir(companyOutput, { recursive: false, mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
      await assertNoLinks(companyOutput);
      const assetDir = under(companyOutput, spec.assetId);
      await fsp.mkdir(assetDir, { recursive: false, mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
      await assertNoLinks(assetDir);
      attempt = await fsp.mkdtemp(path.join(assetDir, ".prepare-"));
      const source = path.join(attempt, spec.kind === "image" ? "source.image" : "source.mp4");
      const sourceInfo = await snapshot(under(companyInput, spec.sourceName), source,
        spec.kind === "image" ? LIMITS.imageBytes : LIMITS.videoBytes, spec.kind);
      const variants = {};
      let commercialReady = true;
      let audioSource;
      let audioFormat;
      let musicSha256;
      let imageGeometry;
      let imageBytes;
      let inputProbe;
      if (spec.kind === "image") {
        // Bounded image bytes also prevent libvips retaining a source file handle
        // on Windows after an early metadata rejection.
        imageBytes = await fsp.readFile(source);
        const metadata = await sharp(imageBytes, { limitInputPixels: LIMITS.imagePixels, failOn: "error" }).metadata();
        requireThat(metadata.format === sourceInfo.format && (metadata.pages || 1) === 1 &&
          metadata.width * metadata.height <= LIMITS.imagePixels, "media_image_invalid");
        imageGeometry = { width: metadata.width, height: metadata.height, orientation: metadata.orientation || 1 };
        if (spec.audioMode === "music") {
          requireThat(musicRoot && typeof resolveMusicTrack === "function", "media_music_unavailable");
          const track = await resolveMusicTrack(spec.musicTrackId);
          requireThat(track && NAME.test(track.sourceName) && /\.(?:wav|mp3)$/i.test(track.sourceName), "media_music_unavailable");
          commercialReady = track.synthetic !== true;
          requireThat(commercialReady ? track.rights?.commercialPublishing === true &&
            typeof track.rights.evidenceId === "string" && track.rights.evidenceId.length > 0 : allowSyntheticAudio === true,
          "media_music_rights_unverified");
          await assertNoLinks(musicRoot);
          audioSource = path.join(attempt, "music.audio");
          const audioInfo = await snapshot(under(musicRoot, track.sourceName), audioSource, LIMITS.musicBytes, "music");
          requireThat(track.sha256 === undefined || (typeof track.sha256 === "string" &&
            /^[a-f0-9]{64}$/.test(track.sha256) && track.sha256 === audioInfo.sha256), "media_music_changed");
          musicSha256 = audioInfo.sha256;
          audioFormat = audioInfo.format;
          const audioProbe = await probe(audioSource, audioFormat, "music", attempt);
          const actualDuration = await decode(audioSource, audioFormat, "music", attempt);
          requireThat(Math.abs(actualDuration - audioProbe.durationSeconds) <= 0.15, "media_duration_mismatch");
        }
      } else {
        inputProbe = await probe(source, "mov", "video", attempt);
        const actualDuration = await decode(source, "mov", "video", attempt);
        requireThat(Math.abs(actualDuration - inputProbe.durationSeconds) <= 0.15, "media_duration_mismatch");
      }
      let thumbnail;
      // Cache only within this owned, immutable preparation attempt. Destination
      // names describe independent deliveries, not different encoded pixels.
      // Never reuse this cache across companies, assets, revisions or attempts.
      const preparedProfiles = new Map();
      // These variants are prepared serially, outside the calendar/publication
      // worker. Scheduling must commit the result only after every variant is ready.
      for (const target of spec.targets) {
        remaining();
        const musical = spec.kind === "image" && spec.musicalTargets.includes(target);
        const video = spec.kind === "video" || musical;
        const width = 1080;
        const height = target === "feed" ? 1350 : 1920;
        const duration = video ? musical ? LIMITS.musicalSeconds : inputProbe.durationSeconds : null;
        const audioMode = musical ? "music" : video ? spec.audioMode : "none";
        const hasAudio = musical || (video && audioMode === "original" && inputProbe.hasAudio);
        const profileKey = JSON.stringify({ profile: "media_render_v1", companyId: spec.companyId,
          assetId: spec.assetId, sourceSha256: sourceInfo.sha256, sourceKind: spec.kind,
          mimeType: video ? "video/mp4" : "image/jpeg", width, height, duration, audioMode,
          hasAudio, musicSha256: musical ? musicSha256 : null,
          composition: spec.kind === "image" ? "contain_blur_v1" : "contain_white_v1",
          encoding: video ? "h264-high-4.1-yuv420p-bt709-crf23-veryfast-30fps-aac128k-48k-stereo" : "jpeg92-444-srgb" });
        if (preparedProfiles.has(profileKey)) {
          variants[target] = preparedProfiles.get(profileKey);
          continue;
        }
        let preparedImage;
        if (spec.kind === "image") {
          preparedImage = path.join(attempt, `${target}.jpg`);
          const foreground = await sharp(imageBytes, { limitInputPixels: LIMITS.imagePixels, failOn: "error" }).timeout({ seconds: imageTimeoutSeconds() })
            .rotate().flatten({ background: "#ffffff" }).resize(width, height, { fit: "inside" }).toColourspace("srgb").png().toBuffer();
          // Only the decorative background is cropped. Every edge of the source
          // stays in the sharp centered foreground, matching the final preview.
          await sharp(imageBytes, { limitInputPixels: LIMITS.imagePixels, failOn: "error" }).timeout({ seconds: imageTimeoutSeconds() })
            .rotate().flatten({ background: "#ffffff" }).resize(width, height, { fit: "cover" }).blur(50)
            .composite([{ input: foreground, gravity: "centre" }])
            .toColourspace("srgb").jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toFile(preparedImage);
          const proof = await sharp(await fsp.readFile(preparedImage)).metadata();
          requireThat(proof.width === width && proof.height === height && proof.format === "jpeg" && !proof.exif && !proof.xmp,
            "media_image_output_invalid");
        }
        if (!video) {
          variants[target] = await commitFile(preparedImage, assetDir, { mimeType: "image/jpeg", width, height,
            sourceSha256: sourceInfo.sha256, durationSeconds: null, audioMode: "none", hasAudio: false, composition: "contain_blur_v1" });
          preparedProfiles.set(profileKey, variants[target]);
          continue;
        }
        const output = path.join(attempt, `${target}.mp4`);
        const inputs = musical ? ["-loop", "1", "-framerate", "30", ...inputArgs(preparedImage, "image2"),
          "-stream_loop", "-1", ...inputArgs(audioSource, audioFormat)] : inputArgs(source, "mov");
        const result = await run(["-v", "error", "-xerror", ...inputs, "-map", "0:v:0",
          ...(hasAudio ? ["-map", musical ? "1:a:0" : "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"] : ["-an"]),
          // Normalize frame timing before geometry filters. With this FFmpeg
          // build, fps after scale loses the last 1/30s on muted 3s sources.
          // Preserve the frame; never invent duration or relax provider limits.
          "-vf", `fps=30,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,format=yuv420p`,
          "-filter_threads", "1", "-threads", "2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p", "-color_primaries", "bt709",
          "-color_trc", "bt709", "-colorspace", "bt709", "-map_metadata", "-1", "-map_metadata:s:v", "-1",
          ...(hasAudio ? ["-map_metadata:s:a", "-1"] : []), "-map_chapters", "-1",
          // Video has already been fully decoded and duration-checked. Do not
          // trim it to ffmpeg's rounded human-readable duration (loses a frame).
          "-metadata", "creation_time=", "-metadata:s:v:0", "rotate=0", "-t", String(musical ? duration : LIMITS.videoSeconds),
          "-fs", String(LIMITS.outputBytes), "-movflags", "+faststart", "-f", "mp4", "-n", output], attempt);
        requireThat(result.code === 0, "media_encode_failed");
        const proof = await probe(output, "mov", "video", attempt);
        const actualDuration = await decode(output, "mov", "video", attempt);
        requireThat(proof.width === width && proof.height === height && proof.rotation === 0 && proof.hasAudio === hasAudio &&
          Math.abs(actualDuration - duration) <= 0.15, "media_video_output_invalid");
        variants[target] = await commitFile(output, assetDir, { mimeType: "video/mp4", width, height,
          sourceSha256: sourceInfo.sha256, ...(musical ? { musicSha256 } : {}),
          durationSeconds: proof.durationSeconds, decodedEndSeconds: actualDuration, audioMode, hasAudio,
          composition: musical ? "contain_blur_v1" : "contain_white_v1", videoCodec: "h264",
          audioCodec: hasAudio ? "aac" : null, color: "bt709", fps: 30 });
        if (!thumbnail) {
          const frame = path.join(attempt, "thumbnail.jpg");
          const frameResult = await run(["-v", "error", ...inputArgs(output, "mov"), "-map", "0:v:0", "-frames:v", "1",
            "-an", "-map_metadata", "-1", "-threads", "2", "-f", "image2", "-n", frame], attempt);
          requireThat(frameResult.code === 0, "media_thumbnail_failed");
          // sharp also strips encoder comments/EXIF and verifies thumbnail geometry.
          const cleaned = path.join(attempt, "thumbnail-clean.jpg");
          await sharp(await fsp.readFile(frame)).timeout({ seconds: imageTimeoutSeconds() }).toColourspace("srgb").jpeg({ quality: 85 }).toFile(cleaned);
          thumbnail = await commitFile(cleaned, assetDir, { mimeType: "image/jpeg", width, height,
            sourceSha256: sourceInfo.sha256, durationSeconds: null, audioMode: "none", hasAudio: false });
        }
        // Share only the fully verified descriptor, never an in-progress output.
        preparedProfiles.set(profileKey, variants[target]);
      }
      const sourceInspection = Object.freeze({ kind: spec.kind, format: sourceInfo.format, decoded: true,
        sha256: sourceInfo.sha256, size: sourceInfo.size,
        width: imageGeometry?.width ?? inputProbe.width, height: imageGeometry?.height ?? inputProbe.height,
        ...(spec.kind === "image" ? { frames: 1 } : { durationSeconds: inputProbe.durationSeconds,
          hasAudio: inputProbe.hasAudio, colorMode: "sdr" }) });
      remaining();
      return Object.freeze({ sourceSha256: sourceInfo.sha256, sourceSize: sourceInfo.size, sourceKind: spec.kind, sourceInspection,
        imageGeometry, inputVideo: inputProbe, variants: Object.freeze(variants), thumbnail,
        commercialReady, elapsedMs: budget.elapsedMs(), policy: "local_gallery_pilot_v1" });
    } catch (error) {
      // Never surface ffmpeg stderr, file contents, filesystem names or metadata.
      if (typeof error.code === "string" && /^media_[a-z_]+$/.test(error.code)) throw error;
      throw fault("media_preparation_failed");
    } finally {
      // Only this generated attempt directory is removed; originals, previous
      // derivatives and other companies are not cleanup targets.
      try {
        if (attempt) {
          const relative = path.relative(outputRoot, attempt);
          if (relative && !relative.startsWith("..") && path.basename(attempt).startsWith(".prepare-")) {
            await assertNoLinks(attempt);
            await fsp.rm(attempt, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          }
        }
      } catch (_) { throw fault("media_cleanup_failed"); }
      finally { activeBudget = undefined; busy = false; }
    }
  }
  return Object.freeze({ prepare });
}

module.exports = { LIMITS, createImportMediaPreparer, createPreparationDeadline, runBoundedProcess, parseProbe, decodedSeconds, validateSpec, sniff };
