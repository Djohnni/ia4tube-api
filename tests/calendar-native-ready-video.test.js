"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { NATIVE_READY_VIDEO_PROFILE, parseNativeReadyVideoProbe, isNativeReadyVideoMetadata, createNativeReadyVideoPreparer } = require("../src/social/calendar/imports/native-ready-video");
const { createPreparedDiskOutputInspector } = require("../src/social/calendar/imports/prepared-disk-output-inspector");
const path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
function probe() { return { format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "15.573" }, streams: [
  { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", sample_aspect_ratio: "1:1",
    avg_frame_rate: "24/1", r_frame_rate: "24/1", field_order: "progressive", color_space: "smpte170m", color_transfer: "iec61966-2-1",
    color_primaries: "bt709", color_range: "tv", duration: "15.542" },
  { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, duration: "15.573" }
] }; }
test("native profile reports the real rate, colour tags and original audio without normalizing them", () => {
  const actual = parseNativeReadyVideoProbe(probe());
  assert.equal(actual.nativeProfile, NATIVE_READY_VIDEO_PROFILE); assert.equal(actual.decoded, false);
  assert.equal(actual.fps, 24); assert.equal(actual.frameRate, "24/1"); assert.equal(actual.color, "smpte170m");
  assert.equal(actual.colorTransfer, "iec61966-2-1"); assert.equal(actual.colorPrimaries, "bt709"); assert.equal(actual.audioSampleRate, 48000);
  assert.equal(isNativeReadyVideoMetadata(actual), true);
  assert.equal(isNativeReadyVideoMetadata({ ...actual, fps: 30 }), false);
  const fractional = probe(); fractional.streams[0].avg_frame_rate = fractional.streams[0].r_frame_rate = "30000/1001";
  assert.equal(parseNativeReadyVideoProbe(fractional).fps, 30000 / 1001);
  const silent = probe(); silent.streams.pop(); assert.equal(parseNativeReadyVideoProbe(silent).hasAudio, false);
});
test("native MP4 rejects ambiguous or incompatible media before claiming any decode", () => {
  const changes = [p => p.streams.push({ codec_type: "subtitle" }), p => p.streams.push(p.streams[0]),
    p => p.streams[0].side_data_list = [{ rotation: -90 }], p => p.streams[0].side_data_list = {},
    p => p.streams[0].sample_aspect_ratio = "4:3", p => p.streams[0].r_frame_rate = "30/1",
    p => p.streams[0].width = 720, p => p.streams[0].codec_name = "hevc", p => p.streams[0].pix_fmt = "yuv420p10le",
    p => p.streams[0].color_transfer = "smpte2084", p => delete p.streams[0].color_space,
    p => p.streams[1].sample_rate = "96000", p => p.streams[1].channels = 6, p => p.streams[1].duration = "5",
    p => p.format.duration = "61", p => p.format.duration = "2.9", p => p.format.format_name = "matroska", p => p.streams[0] = null];
  for (const change of changes) { const candidate = probe(); change(candidate); assert.throws(() => parseNativeReadyVideoProbe(candidate),
    error => /^native_ready_video_/.test(error.code)); }
});

test("missing or unavailable SAR accepts intrinsic square pixels without changing real metadata", () => {
  for (const sar of [undefined, "N/A"]) {
    const candidate = probe();
    if (sar === undefined) delete candidate.streams[0].sample_aspect_ratio;
    else candidate.streams[0].sample_aspect_ratio = sar;
    const actual = parseNativeReadyVideoProbe(candidate);
    assert.equal(actual.width, 1080); assert.equal(actual.height, 1920);
    assert.equal(actual.fps, 24); assert.equal(actual.color, "smpte170m");
    assert.equal(actual.colorTransfer, "iec61966-2-1"); assert.equal(actual.decoded, false);
    candidate.streams[0].tags = { rotate: "90" };
    assert.throws(() => parseNativeReadyVideoProbe(candidate), { code: "native_ready_video_geometry_invalid" });
  }
});

test("an explicit 2:1 SAR remains incompatible with the passthrough profile", () => {
  const candidate = probe(); candidate.streams[0].sample_aspect_ratio = "2:1";
  assert.throws(() => parseNativeReadyVideoProbe(candidate), { code: "native_ready_video_geometry_invalid" });
});
test("profile is explicit and native preparer refuses conversion, traversal and unsupported selections", async () => {
  assert.throws(() => createPreparedDiskOutputInspector({ nativeProfile: "loose" }), { code: "prepared_disk_inspection_invalid" });
  const preparer = createNativeReadyVideoPreparer({ inputRoot: path.join(os.tmpdir(), "input"), outputRoot: path.join(os.tmpdir(), "output"),
    ffmpegPath: path.join(os.tmpdir(), "ffmpeg"), ffprobePath: path.join(os.tmpdir(), "ffprobe") });
  const spec = { companyId: crypto.randomUUID(), assetId: crypto.randomUUID(), sourceName: "source.mp4", kind: "video",
    targets: ["reel"], audioMode: "original", musicalTargets: [], musicTrackId: null };
  for (const patch of [{ sourceName: "../source.mp4" }, { targets: ["feed"] }, { audioMode: "muted" }, { musicTrackId: crypto.randomUUID() },
    { musicalTargets: ["reel"] }, { musicTrackId: 0 }, { musicalTargets: {} }, { targets: ["reel", "reel"] }]) await assert.rejects(preparer.prepare({ ...spec, ...patch }),
      { code: "native_ready_video_selection_invalid" });
});

test("a 180-second preparation budget never exceeds the codec's 30-second call contract", async t => {
  const fs = require("node:fs/promises"), moduleId = require.resolve("../src/social/calendar/imports/ready-video-codec-executor");
  require(moduleId); const previous = require.cache[moduleId].exports, calls = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-codec-budget-")), filePath = path.join(root, "contract.mp4");
  t.after(async () => { require.cache[moduleId].exports = previous; await fs.rm(root, { recursive: true, force: true }); });
  // This synthetic header exercises only the call/deadline contract, not decode.
  const header = Buffer.alloc(24); header.writeUInt32BE(24); header.write("ftypisom", 4); await fs.writeFile(filePath, header);
  const codec = { async run(request) {
    assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 30000, "real codec rejects larger per-call deadlines");
    calls.push(request);
    return { code: 0, stdout: request.operation === "probe" ? JSON.stringify(probe()) : "out_time_us=15573000\nprogress=end\n", stderr: "",
      termination: { proved: true, descendants: 0, proofId: "a".repeat(64) } };
  } };
  require.cache[moduleId].exports = { ...previous, isReadyVideoCodecExecutor: value => value === codec };
  const { inspectNativeReadyVideo } = require("../src/social/calendar/imports/native-ready-video");
  const value = await inspectNativeReadyVideo({ filePath, codecExecutor: codec, timeoutMs: 180000 });
  assert.equal(value.fps, 24); assert.deepEqual(calls.map(row => row.operation), ["probe", "decode"]);
  assert.ok(calls.every(row => row.timeoutMs === 30000));
});
