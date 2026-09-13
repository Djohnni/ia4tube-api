"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const sharp = require("sharp");
const { LIMITS, createImportMediaPreparer, createPreparationDeadline, runBoundedProcess, parseProbe, decodedSeconds, validateSpec, sniff } =
  require("../src/social/calendar/imports/preparation");
const { publicationPlan, previewDigest } = require("../src/social/calendar/imports/policy");

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FFMPEG = process.env.FFMPEG_TEST_BINARY || path.resolve(__dirname,
  "../../video_audit/pydeps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");
const baseSpec = extra => ({ companyId: COMPANY, assetId: crypto.randomUUID(), sourceName: "photo.png",
  kind: "image", targets: ["feed", "story"], audioMode: "none", ...extra });

async function environment(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ia4tube-media-local-"));
  t.after(async () => {
    const actual = await fsp.realpath(root);
    assert.equal(actual, path.resolve(root));
    assert.ok(path.basename(actual).startsWith("ia4tube-media-local-"));
    await fsp.rm(actual, { recursive: true, force: true });
  });
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const musicRoot = path.join(root, "music");
  await fsp.mkdir(path.join(inputRoot, COMPANY), { recursive: true });
  await fsp.mkdir(path.join(inputRoot, OTHER));
  await fsp.mkdir(outputRoot);
  await fsp.mkdir(musicRoot);
  const service = createImportMediaPreparer({ inputRoot, outputRoot, musicRoot, ffmpegPath: FFMPEG, ...options });
  return { root, inputRoot, outputRoot, musicRoot, service,
    source: name => path.join(inputRoot, COMPANY, name),
    derivative: (spec, variant) => path.join(outputRoot, spec.companyId, spec.assetId, variant.fileName) };
}

async function makePhoto(file) {
  const red = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#0000ff" } }).png().toBuffer();
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } })
    .composite([{ input: red, left: 0, top: 0 }, { input: blue, left: 100, top: 0 }])
    .withMetadata({ exif: { IFD0: { Artist: "iA4tube synthetic test only", Copyright: "Not a customer asset" } } })
    .png().toFile(file);
}

async function pixel(file, x, y) {
  return [...await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
}

function wav(seconds = 1) {
  const sampleRate = 48000;
  const sampleCount = seconds * sampleRate;
  const result = Buffer.alloc(44 + sampleCount * 2);
  result.write("RIFF", 0); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write("data", 36);
  result.writeUInt32LE(sampleCount * 2, 40);
  for (let i = 0; i < sampleCount; i++) result.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 1200), 44 + i * 2);
  return result;
}

async function makeVideo(file, cwd, extra = []) {
  const result = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "3", "-threads", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    "-c:a", "aac", "-metadata", "title=Synthetic controlled test", "-metadata:s:v:0", "handler_name=Synthetic private video tag",
    "-metadata:s:a:0", "handler_name=Synthetic private audio tag", "-movflags", "+faststart", ...extra, "-n", file], { cwd });
  assert.equal(result.code, 0, "Synthetic fixture generation must succeed");
}

test("spec validates independent photo/video targets and never turns Feed into an implicit video", () => {
  assert.equal(validateSpec(baseSpec()).audioMode, "none");
  assert.throws(() => validateSpec(baseSpec({ sourceName: "../secret.png" })), { code: "media_request_invalid" });
  assert.throws(() => validateSpec(baseSpec({ sourceName: "https://example.com/photo.png" })), { code: "media_request_invalid" });
  assert.throws(() => validateSpec(baseSpec({ kind: "video", targets: ["feed"], audioMode: "original" })), { code: "media_video_options_invalid" });
  assert.throws(() => validateSpec(baseSpec({ targets: ["reel"] })), { code: "media_reel_requires_video" });
  assert.throws(() => validateSpec(baseSpec({ audioMode: "music", musicTrackId: "track", musicalTargets: ["feed"] })), { code: "media_music_targets_invalid" });
  assert.equal(validateSpec(baseSpec({ audioMode: "music", musicTrackId: "track", musicalTargets: ["story"] })).targets.length, 2);
});

test("actual signatures, decoded completion, duration and known video profiles fail closed", () => {
  assert.throws(() => sniff(Buffer.from("<svg>not an image</svg>"), "image"), { code: "media_signature_unsupported" });
  assert.throws(() => sniff(Buffer.from("#EXTM3U\nhttps://example.com/private"), "video"), { code: "media_signature_unsupported" });
  assert.throws(() => decodedSeconds("out_time_us=3000000\nprogress=continue\n"), { code: "media_decode_incomplete" });
  assert.throws(() => decodedSeconds("out_time_us=61000000\nprogress=end\n"), { code: "media_duration_invalid" });
  const sample = "Duration: 00:00:03.00, start: 0.000000\n Stream #0:0(und): Video: h264 (High), yuv420p(progressive), 360x640, 30 fps\n Stream #0:1(und): Audio: aac (LC), 48000 Hz, mono\n";
  assert.equal(parseProbe(sample, "video").hasAudio, true);
  assert.throws(() => parseProbe(sample.replace("00:00:03", "00:01:01"), "video"), { code: "media_duration_invalid" });
  assert.throws(() => parseProbe(sample.replace("h264", "hevc"), "video"), { code: "media_video_codec_unsupported" });
  assert.throws(() => parseProbe(sample.replace("yuv420p", "yuv420p10le(bt2020/smpte2084)"), "video"), { code: "media_video_color_unsupported" });
  assert.throws(() => parseProbe(sample + " Stream #0:2: Data: bin_data\n", "video"), { code: "media_streams_unsupported" });
});

test("bounded process never uses a shell, inherits credentials or exposes unlimited process output", async () => {
  let observed;
  const fake = (_binary, _args, options) => {
    observed = options;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit("close", null));
    setImmediate(() => child.stderr.write(Buffer.alloc(200)));
    return child;
  };
  await assert.rejects(runBoundedProcess("trusted-ffmpeg", ["-version"], { spawnProcess: fake, maxOutputBytes: 100 }),
    { code: "media_process_output_limit" });
  assert.equal(observed.shell, false);
  assert.equal(observed.windowsHide, true);
  assert.deepEqual(Object.keys(observed.env).filter(key => !["LANG", "LC_ALL", "SystemRoot"].includes(key)), []);
  const neverEnds = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit("close", null));
    return child;
  };
  await assert.rejects(runBoundedProcess("trusted-ffmpeg", [], { spawnProcess: neverEnds, timeoutMs: 10 }),
    { code: "media_process_timeout" });
});

test("photo derivatives preserve both sides, correct geometry, remove metadata, and retain original", async t => {
  const env = await environment(t);
  await makePhoto(env.source("photo.png"));
  const before = await fsp.readFile(env.source("photo.png"));
  const spec = baseSpec();
  const result = await env.service.prepare(spec);
  assert.equal(result.commercialReady, true);
  assert.equal(result.sourceSize, before.length);
  for (const [target, height] of [["feed", 1350], ["story", 1920]]) {
    const asset = result.variants[target];
    assert.equal(asset.width, 1080); assert.equal(asset.height, height); assert.equal(asset.mimeType, "image/jpeg");
    assert.equal(asset.sourceSha256, result.sourceSha256);
    assert.equal(asset.composition, "contain_blur_v1");
    const file = env.derivative(spec, asset);
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined);
    const red = await pixel(file, 30, Math.floor(height / 2));
    const blue = await pixel(file, 1040, Math.floor(height / 2));
    const margin = await pixel(file, 500, 10);
    assert.ok(red[0] > 240 && red[1] < 10 && red[2] < 10);
    assert.ok(blue[2] > 240 && blue[0] < 10 && blue[1] < 10);
    assert.ok(!margin.every(channel => channel > 245), "decorative margin comes from the image, not a fixed white letterbox");
  }
  assert.deepEqual(await fsp.readFile(env.source("photo.png")), before);
  if (process.env.MEDIA_PREPARATION_WRITE_SYNTHETIC_PREVIEWS === "1") {
    const evidence = path.resolve(__dirname, "../../../outputs");
    for (const target of ["feed", "story"]) {
      const destination = path.join(evidence, `GALLERY_PREP_SYNTHETIC_${target.toUpperCase()}_2026-09-12.jpg`);
      await fsp.copyFile(env.derivative(spec, result.variants[target]), destination, fs.constants.COPYFILE_EXCL);
    }
  }
  const again = await env.service.prepare(spec);
  assert.equal(result.variants.feed.sha256, again.variants.feed.sha256);
  assert.equal(result.variants.story.sha256, again.variants.story.sha256);
  assert.deepEqual((await fsp.readdir(path.dirname(env.derivative(spec, result.variants.feed)))).filter(name => name.startsWith(".prepare-")), []);
  console.log("LOCAL_IMAGE_BENCHMARK=" + JSON.stringify({ elapsedMs: result.elapsedMs, sourceBytes: result.sourceSize,
    feedBytes: result.variants.feed.size, storyBytes: result.variants.story.size, retainedCorners: true, exifRemoved: true }));
});

test("image EXIF orientation is honored and animated input is rejected", async t => {
  const env = await environment(t);
  await makePhoto(env.source("photo.png"));
  await sharp(await fsp.readFile(env.source("photo.png")))
    .withMetadata({ orientation: 6 }).jpeg().toFile(env.source("oriented.jpg"));
  const spec = baseSpec({ sourceName: "oriented.jpg", targets: ["feed"] });
  const result = await env.service.prepare(spec);
  assert.equal(result.imageGeometry.orientation, 6);
  const file = env.derivative(spec, result.variants.feed);
  const top = await pixel(file, 540, 200);
  const bottom = await pixel(file, 540, 1100);
  assert.ok(top[0] > 220 && bottom[2] > 220, "rotation must turn the horizontal red/blue landmark pair into top/bottom");
  const frames = Buffer.alloc(8 * 16 * 3);
  for (let offset = 0; offset < frames.length; offset += 3) frames[offset + (offset < frames.length / 2 ? 0 : 2)] = 255;
  await sharp(frames, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } })
    .webp({ loop: 0, delay: [100, 100] }).toFile(env.source("animated.webp"));
  assert.equal((await sharp(await fsp.readFile(env.source("animated.webp"))).metadata()).pages, 2);
  await assert.rejects(env.service.prepare(baseSpec({ sourceName: "animated.webp" })), { code: "media_image_invalid" });
});

test("invalid bytes, unauthorized company path and unlicensed music never become prepared", async t => {
  const env = await environment(t, { resolveMusicTrack: async () => ({ sourceName: "tone.wav", rights: { commercialPublishing: false } }) });
  await fsp.writeFile(env.source("fake.png"), "<svg onload='unsafe'>text</svg>");
  await assert.rejects(env.service.prepare(baseSpec({ sourceName: "fake.png" })), { code: "media_signature_unsupported" });
  await makePhoto(env.source("photo.png"));
  await assert.rejects(env.service.prepare(baseSpec({ companyId: OTHER })), { code: "media_preparation_failed" });
  await assert.rejects(env.service.prepare(baseSpec({ audioMode: "music", musicTrackId: "unlicensed", musicalTargets: ["story"] })),
    { code: "media_music_rights_unverified" });
  assert.deepEqual(await fsp.readdir(env.musicRoot), []);
});

test("symbolic-link company directory is not followed", async t => {
  const env = await environment(t);
  const linkCompany = "33333333-3333-4333-8333-333333333333";
  try { await fsp.symlink(path.join(env.inputRoot, COMPANY), path.join(env.inputRoot, linkCompany), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Host does not permit synthetic symlink fixture"); throw error; }
  await assert.rejects(env.service.prepare(baseSpec({ companyId: linkCompany })), { code: "media_link_forbidden" });
});

test("synthetic musical Story and normal Feed are distinct, with no commercial music claim", { skip: !fs.existsSync(FFMPEG), timeout: 180000 }, async t => {
  const calls = [];
  const env = await environment(t, { allowSyntheticAudio: true,
    resolveMusicTrack: async id => id === "synthetic-tone" ? { sourceName: "tone.wav", synthetic: true } : null,
    processRunner: async (file, args, options) => { calls.push(args); return runBoundedProcess(file, args, options); } });
  await makePhoto(env.source("photo.png"));
  await fsp.writeFile(path.join(env.musicRoot, "tone.wav"), wav());
  const spec = baseSpec({ audioMode: "music", musicTrackId: "synthetic-tone", musicalTargets: ["story"] });
  const result = await env.service.prepare(spec);
  assert.equal(result.commercialReady, false);
  assert.equal(result.variants.feed.mimeType, "image/jpeg");
  assert.equal(result.variants.story.mimeType, "video/mp4");
  assert.equal(result.variants.story.hasAudio, true);
  assert.equal(result.variants.story.audioCodec, "aac");
  assert.equal(result.variants.story.musicSha256, crypto.createHash("sha256").update(wav()).digest("hex"));
  assert.equal(result.variants.story.sourceSha256, result.sourceSha256);
  assert.ok(Math.abs(result.variants.story.durationSeconds - 15) < 0.15);
  assert.equal(result.thumbnail.mimeType, "image/jpeg");
  assert.ok(calls.every(args => args.includes("-protocol_whitelist") && args[args.indexOf("-protocol_whitelist") + 1] === "file,pipe"));
  assert.ok(calls.filter(args => args.includes("-enable_drefs")).every(args => args[args.indexOf("-enable_drefs") + 1] === "0"));
  console.log("LOCAL_MUSICAL_BENCHMARK=" + JSON.stringify({ elapsedMs: result.elapsedMs, sourceBytes: result.sourceSize,
    feedBytes: result.variants.feed.size, storyBytes: result.variants.story.size, durationSeconds: result.variants.story.durationSeconds,
    width: result.variants.story.width, height: result.variants.story.height, hasAudio: true, commercialReady: false }));
});

test("MP4 normalizes to Reel/Story with original audio or silence and strips metadata", { skip: !fs.existsSync(FFMPEG), timeout: 180000 }, async t => {
  const env = await environment(t);
  await makeVideo(env.source("clip.mp4"), env.root);
  const originalSpec = baseSpec({ sourceName: "clip.mp4", kind: "video", targets: ["reel"], audioMode: "original" });
  const original = await env.service.prepare(originalSpec);
  const mutedSpec = { ...originalSpec, assetId: crypto.randomUUID(), audioMode: "muted", targets: ["story"] };
  const muted = await env.service.prepare(mutedSpec);
  assert.equal(original.variants.reel.hasAudio, true);
  assert.equal(muted.variants.story.hasAudio, false);
  assert.equal(original.variants.reel.width, 1080);
  assert.equal(original.variants.reel.height, 1920);
  const metadata = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-i", env.derivative(originalSpec, original.variants.reel)], { cwd: env.root });
  assert.equal(metadata.stderr.includes("Synthetic controlled test"), false);
  assert.equal(metadata.stderr.includes("Synthetic private"), false);
  console.log("LOCAL_VIDEO_BENCHMARK=" + JSON.stringify({ sourceBytes: original.sourceSize, originalElapsedMs: original.elapsedMs,
    mutedElapsedMs: muted.elapsedMs, originalBytes: original.variants.reel.size, mutedBytes: muted.variants.story.size,
    durationSeconds: original.variants.reel.durationSeconds, width: 1080, height: 1920, audioAndSilenceVerified: true }));
});

test("MOV is inspected by actual container and normalized without relying on file extension", { skip: !fs.existsSync(FFMPEG), timeout: 60000 }, async t => {
  const env = await environment(t);
  await makeVideo(env.source("clip.mov"), env.root, ["-f", "mov"]);
  const result = await env.service.prepare(baseSpec({ sourceName: "clip.mov", kind: "video", targets: ["story"], audioMode: "muted" }));
  assert.equal(result.variants.story.mimeType, "video/mp4");
  assert.equal(result.variants.story.hasAudio, false);
  assert.ok(Math.abs(result.variants.story.durationSeconds - 3) <= 1 / 30 + 0.01);
  const damaged = (await fsp.readFile(env.source("clip.mov"))).subarray(0, 5000);
  await fsp.writeFile(env.source("damaged.mov"), damaged);
  await assert.rejects(env.service.prepare(baseSpec({ sourceName: "damaged.mov", kind: "video", targets: ["story"], audioMode: "muted" })),
    error => ["media_probe_failed", "media_decode_failed", "media_video_codec_unsupported", "media_video_color_unsupported",
      "media_geometry_unverified", "media_duration_mismatch"].includes(error.code));
});

test("video display rotation is applied to pixels and cleared from the prepared MP4", { skip: !fs.existsSync(FFMPEG), timeout: 60000 }, async t => {
  const env = await environment(t);
  const plain = env.source("unrotated.mp4");
  const fixture = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
    "color=c=red:s=360x640:r=30,drawbox=x=180:y=0:w=180:h=640:color=blue:t=fill", "-t", "1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2", "-n", plain], { cwd: env.root });
  assert.equal(fixture.code, 0);
  const rotated = env.source("rotated.mov");
  const remux = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-display_rotation", "90", "-i", plain,
    "-c", "copy", "-f", "mov", "-n", rotated], { cwd: env.root });
  assert.equal(remux.code, 0);
  const spec = baseSpec({ sourceName: "rotated.mov", kind: "video", targets: ["story"], audioMode: "original" });
  const result = await env.service.prepare(spec);
  assert.equal(Math.abs(result.inputVideo.rotation), 90);
  assert.equal(result.variants.story.hasAudio, false);
  const thumb = env.derivative(spec, result.thumbnail);
  const margin = await pixel(thumb, 540, 100);
  assert.ok(margin.every(channel => channel > 240));
  const top = await pixel(thumb, 540, 760);
  const bottom = await pixel(thumb, 540, 1160);
  const colors = [top, bottom].sort((a, b) => a[0] - b[0]);
  assert.ok(colors[0][2] > 220 && colors[0][0] < 30 && colors[1][0] > 220 && colors[1][2] < 30,
    "the left/right source landmarks must become top/bottom, not stay unrotated or cropped");
});

test("one preparer does not run simultaneous tasks and recovers after a rejected task", async t => {
  let release;
  let reached;
  const atMusic = new Promise(resolve => { reached = resolve; });
  const env = await environment(t, { resolveMusicTrack: async () => { reached(); return new Promise(resolve => { release = resolve; }); } });
  await makePhoto(env.source("photo.png"));
  const first = env.service.prepare(baseSpec({ audioMode: "music", musicTrackId: "waiting", musicalTargets: ["story"] }));
  await atMusic;
  await assert.rejects(env.service.prepare(baseSpec()), { code: "media_preparer_busy" });
  release(null);
  await assert.rejects(first, { code: "media_music_unavailable" });
  assert.equal((await env.service.prepare(baseSpec())).variants.feed.mimeType, "image/jpeg");
});

test("trusted synthetic MP3 longer than one minute produces only 15s and binds real hashes to policy preview", { skip: !fs.existsSync(FFMPEG), timeout: 180000 }, async t => {
  let catalogEntry;
  const env = await environment(t, { allowSyntheticAudio: true,
    resolveMusicTrack: async id => id === "synthetic-mp3" ? catalogEntry : null });
  await makePhoto(env.source("photo.png"));
  const musicWav = path.join(env.musicRoot, "long-tone.wav");
  const musicMp3 = path.join(env.musicRoot, "long-tone.mp3");
  await fsp.writeFile(musicWav, wav(65));
  const encode = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-i", musicWav,
    "-map_metadata", "-1", "-c:a", "libmp3lame", "-q:a", "6", "-n", musicMp3], { cwd: env.root });
  assert.equal(encode.code, 0);
  const musicHash = crypto.createHash("sha256").update(await fsp.readFile(musicMp3)).digest("hex");
  catalogEntry = { sourceName: "long-tone.mp3", synthetic: true, sha256: musicHash };
  const selection = { kind: "image", targets: ["feed", "story"], audioMode: "music",
    musicTrackId: "synthetic-mp3", musicalTargets: ["story"], shareToFeed: false };
  const result = await env.service.prepare(baseSpec(selection));
  assert.equal(result.commercialReady, false);
  assert.equal(result.variants.story.durationSeconds, 15);
  assert.equal(result.variants.story.musicSha256, musicHash);
  const catalog = new Map([["synthetic-mp3", { id: "synthetic-mp3", sha256: musicHash,
    durationSeconds: 65, syntheticTestOnly: true }]]);
  const plan = publicationPlan(selection, result.sourceInspection, { catalog, companyId: COMPANY,
    now: 1000, publishAt: 2000, testMode: true });
  assert.equal(plan.testOnly, true);
  const fingerprint = previewDigest(plan, result.variants);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => previewDigest(plan, { ...result.variants,
    story: { ...result.variants.story, musicSha256: "0".repeat(64) } }), { code: "calendar_import_preview_invalid" });
  catalogEntry = { ...catalogEntry, sha256: "0".repeat(64) };
  await assert.rejects(env.service.prepare(baseSpec(selection)), { code: "media_music_changed" });
  console.log("LOCAL_MP3_POLICY_BENCHMARK=" + JSON.stringify({ elapsedMs: result.elapsedMs, sourceAudioSeconds: 65,
    sourceAudioBytes: (await fsp.stat(musicMp3)).size, outputSeconds: result.variants.story.durationSeconds,
    outputBytes: result.variants.story.size, realPreviewDigestVerified: true, commercialReady: false }));
});

test("declared oversize and processing unavailable fail without a false ready result", async t => {
  const env = await environment(t);
  const file = await fsp.open(env.source("oversize.mp4"), "wx");
  await file.truncate(LIMITS.videoBytes + 1); await file.close();
  await assert.rejects(env.service.prepare(baseSpec({ sourceName: "oversize.mp4", kind: "video", targets: ["story"], audioMode: "original" })),
    { code: "media_size_invalid" });
  assert.deepEqual((await fsp.readdir(env.outputRoot)).filter(name => name !== COMPANY), []);
});

test("equivalent Story/Reel video encodes once but keeps both explicit destinations", { skip: !fs.existsSync(FFMPEG), timeout: 180000 }, async t => {
  const calls = [];
  const env = await environment(t, { processRunner: async (file, args, options) => {
    calls.push(args); return runBoundedProcess(file, args, options);
  } });
  await makeVideo(env.source("clip.mp4"), env.root);
  const spec = baseSpec({ sourceName: "clip.mp4", kind: "video", targets: ["story", "reel"], audioMode: "original", shareToFeed: true });
  const result = await env.service.prepare(spec);
  assert.equal(calls.filter(args => args.includes("libx264")).length, 1);
  assert.deepEqual(Object.keys(result.variants), ["story", "reel"]);
  assert.equal(result.variants.story.sha256, result.variants.reel.sha256);
  assert.equal(result.variants.story.fileName, result.variants.reel.fileName);
  assert.equal(result.variants.story.hasAudio, true);
  assert.ok(Object.isFrozen(result.variants.story));
  const chosen = { kind: "video", targets: ["story", "reel"], audioMode: "original", shareToFeed: true };
  const plan = publicationPlan(chosen, result.sourceInspection, { companyId: COMPANY });
  assert.equal(plan.deliveries.length, 2);
  assert.equal(plan.deliveries.find(part => part.target === "reel").shareToFeed, true);
  assert.equal(plan.deliveries.find(part => part.target === "story").shareToFeed, false);
  assert.match(previewDigest(plan, result.variants), /^[a-f0-9]{64}$/);
  assert.equal((await fsp.readdir(path.dirname(env.derivative(spec, result.variants.story)))).filter(name => name.endsWith(".mp4")).length, 1);
});

test("musical Story/Reel share one encode while the Feed photo stays independent", { skip: !fs.existsSync(FFMPEG), timeout: 180000 }, async t => {
  const calls = [];
  const env = await environment(t, { allowSyntheticAudio: true,
    resolveMusicTrack: async () => ({ sourceName: "tone.wav", synthetic: true }),
    processRunner: async (file, args, options) => { calls.push(args); return runBoundedProcess(file, args, options); } });
  await makePhoto(env.source("photo.png"));
  await fsp.writeFile(path.join(env.musicRoot, "tone.wav"), wav());
  const result = await env.service.prepare(baseSpec({ targets: ["reel", "feed", "story"], audioMode: "music",
    musicTrackId: "synthetic-tone", musicalTargets: ["story", "reel"] }));
  assert.equal(calls.filter(args => args.includes("libx264")).length, 1);
  assert.equal(result.commercialReady, false);
  assert.equal(result.variants.story.sha256, result.variants.reel.sha256);
  assert.equal(result.variants.story.musicSha256, crypto.createHash("sha256").update(wav()).digest("hex"));
  assert.equal(result.variants.feed.mimeType, "image/jpeg");
  assert.equal(result.variants.feed.height, 1350);
  assert.notEqual(result.variants.feed.sha256, result.variants.reel.sha256);
});

test("profile reuse never crosses attempts, audio modes, sources or companies", { skip: !fs.existsSync(FFMPEG), timeout: 180000 }, async t => {
  let encodes = 0;
  const env = await environment(t, { processRunner: async (file, args, options) => {
    if (args.includes("libx264")) encodes++; return runBoundedProcess(file, args, options);
  } });
  await makeVideo(env.source("clip.mp4"), env.root);
  const spec = baseSpec({ sourceName: "clip.mp4", kind: "video", targets: ["story", "reel"], audioMode: "original" });
  const first = await env.service.prepare(spec);
  const muted = await env.service.prepare({ ...spec, audioMode: "muted" });
  assert.equal(encodes, 2);
  assert.equal(muted.variants.story.hasAudio, false);
  assert.notEqual(first.variants.story.sha256, muted.variants.story.sha256);
  await fsp.copyFile(env.source("clip.mp4"), path.join(env.inputRoot, OTHER, "clip.mp4"));
  const otherSpec = { ...spec, companyId: OTHER };
  const other = await env.service.prepare(otherSpec);
  assert.equal(encodes, 3);
  assert.notEqual(env.derivative(spec, first.variants.story), env.derivative(otherSpec, other.variants.story));
  assert.equal(other.variants.story.sha256, first.variants.story.sha256);
  // The same file name now holds a different owned source; no previous output is reused.
  await fsp.copyFile(env.derivative(spec, muted.variants.story), env.source("clip.mp4"));
  const changed = await env.service.prepare(spec);
  assert.equal(encodes, 4);
  assert.notEqual(changed.sourceSha256, first.sourceSha256);
  assert.equal(changed.variants.story.sourceSha256, changed.sourceSha256);
});

test("preparation deadline spans stages and cannot grow after a wall-clock rollback", () => {
  let wall = 10000, monotonic = 100;
  const budget = createPreparationDeadline({ clock: () => wall, monotonicClock: () => monotonic,
    maxRuntimeMs: 1000, deadlineAt: 10600 });
  assert.equal(budget.remaining(), 600);
  wall += 200; monotonic += 200;
  assert.equal(budget.remaining(), 400);
  wall -= 1000; monotonic += 100;
  assert.equal(budget.remaining(), 300);
  assert.equal(budget.elapsedMs(), 300);
  monotonic += 300;
  assert.throws(() => budget.remaining(), { code: "media_task_deadline_exceeded" });
  assert.throws(() => createPreparationDeadline({ clock: () => 1000, deadlineAt: 1000 }), { code: "media_task_deadline_exceeded" });
  assert.throws(() => createPreparationDeadline({ maxRuntimeMs: LIMITS.processTimeoutMs + 1 }), { code: "media_budget_invalid" });
});

test("expired task does no file or process work and late work never returns a ready result", async t => {
  let wall = 1000, mono = 100, processes = 0;
  const env = await environment(t, { clock: () => wall, monotonicClock: () => mono,
    resolveMusicTrack: async () => { wall += 1000; mono += 1000; return { sourceName: "tone.wav", synthetic: true }; },
    allowSyntheticAudio: true,
    processRunner: async () => { processes++; throw new Error("must not run"); } });
  const spec = baseSpec({ audioMode: "music", musicTrackId: "tone", musicalTargets: ["story"] });
  await assert.rejects(env.service.prepare(spec, { deadlineAt: 999 }), { code: "media_task_deadline_exceeded" });
  assert.deepEqual(await fsp.readdir(env.outputRoot), []);
  await makePhoto(env.source("photo.png"));
  await fsp.writeFile(path.join(env.musicRoot, "tone.wav"), wav());
  await assert.rejects(env.service.prepare(spec, { deadlineAt: 1500 }), { code: "media_task_deadline_exceeded" });
  assert.equal(processes, 0);
  assert.deepEqual((await fsp.readdir(path.join(env.outputRoot, COMPANY, spec.assetId))).filter(name => name.startsWith(".prepare-")), []);
  assert.equal((await env.service.prepare(baseSpec())).variants.feed.mimeType, "image/jpeg");
});

test("every ffmpeg stage receives only the remaining total preparation budget", { skip: !fs.existsSync(FFMPEG), timeout: 180000 }, async t => {
  let wall = 1000, monotonic = 100;
  const timeouts = [];
  const env = await environment(t, { clock: () => wall, monotonicClock: () => monotonic,
    processRunner: async (file, args, options) => {
      timeouts.push(options.timeoutMs);
      const result = await runBoundedProcess(file, args, options);
      wall += 100; monotonic += 100;
      return result;
    } });
  await makeVideo(env.source("clip.mp4"), env.root);
  const result = await env.service.prepare(baseSpec({ sourceName: "clip.mp4", kind: "video", targets: ["story", "reel"], audioMode: "muted" }),
    { deadlineAt: 31000 });
  assert.equal(result.variants.story.mimeType, "video/mp4");
  assert.ok(timeouts.length > 3);
  assert.equal(timeouts[0], 30000);
  assert.ok(timeouts.every((timeout, index) => timeout === 30000 - index * 100));
});

test("successful preparation reports monotonic elapsed time even when wall time moves backwards", async t => {
  let wall = 100000, monotonic = 1000;
  const env = await environment(t, { clock: () => { wall -= 100; return wall; },
    monotonicClock: () => { monotonic += 10; return monotonic; } });
  await makePhoto(env.source("photo.png"));
  const result = await env.service.prepare(baseSpec());
  assert.ok(wall < 99800);
  assert.ok(Number.isSafeInteger(result.elapsedMs) && result.elapsedMs > 0);
  assert.equal(result.elapsedMs, monotonic - 1010);
  assert.equal(result.variants.feed.mimeType, "image/jpeg");
});
