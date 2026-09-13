"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { createOperationalPrivatePipelineFixture, FFMPEG, coordinator } = require("./helpers/operational-private-pipeline-fixture");
const { runBoundedProcess } = require("../src/social/calendar/imports/preparation");
test("Linux candidate limit: actual 60s portrait video near 100MiB crosses upload, inspection, preparation and final decode", { timeout: 450000 }, async t => {
  assert.equal(process.platform, "linux");
  const f = await createOperationalPrivatePipelineFixture(t), source = path.join(f.root, "candidate-60s-portrait.mp4");
  const generated = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "60", "-threads", "2", "-filter_threads", "1", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-b:v", "13M", "-minrate", "13M", "-maxrate", "13M", "-bufsize", "26M", "-x264-params", "nal-hrd=cbr:force-cfr=1",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-n", source], { cwd: f.root, timeoutMs: 180000 });
  assert.equal(generated.code, 0, "Synthetic candidate creation failed");
  const bytes = await fs.readFile(source); assert.ok(bytes.length >= 92 * 1024 ** 2 && bytes.length <= 100 * 1024 ** 2, `Candidate bytes=${bytes.length}`);
  const started = performance.now(), ready = await f.prepareVideo({ bytes, selection: { kind: "video", targets: ["story", "reel"], audioMode: "original", shareToFeed: true } });
  t.diagnostic(JSON.stringify({ case: "linux-candidate-limit", sourceBytes: bytes.length, width: 1080, height: 1920, seconds: 60,
    elapsedMs: Math.ceil(performance.now() - started), ready: ready.status.ready, status: ready.status.state, code: ready.status.errorCode }));
  const observations = [];
  for (const name of await fs.readdir(f.executorRoot)) if (/^[a-f0-9-]{36}$/.test(name)) {
    const intent = JSON.parse(await fs.readFile(path.join(f.executorRoot, name, "request.json"), "utf8")), observation = await f.executor.observe(name);
    observations.push({ operation: intent.operation, state: observation.state, reason: observation.reason, elapsedMs: observation.elapsedMs,
      metrics: observation.metrics, limits: observation.limits, terminationProved: observation.termination?.proved });
  }
  t.diagnostic(JSON.stringify({ case: "linux-candidate-limit-processes", observations }));
  assert.equal(ready.status.ready, true, "Candidate must succeed under original180s/512MiB/1CPU bounds; failure is retained evidence, not a relaxed timeout");
  const actual = await f.actualFor(ready.assetId, ready.mediaRevision);
  for (const variant of Object.values(actual.prepared.variants)) {
    assert.equal(variant.width, 1080); assert.equal(variant.height, 1920); assert.equal(variant.hasAudio, true);
    assert.ok(Math.abs(variant.decodedEndSeconds - 60) < 0.15);
  }
  assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 0);
});
