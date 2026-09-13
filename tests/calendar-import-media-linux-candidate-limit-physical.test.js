"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { createOperationalPrivatePipelineFixture, FFMPEG, coordinator } = require("./helpers/operational-private-pipeline-fixture");
const { runBoundedProcess } = require("../src/social/calendar/imports/preparation");
test("Linux candidate limit: actual 60s portrait video at exactly 100MiB crosses upload, inspection, preparation and final decode", { timeout: 450000 }, async t => {
  assert.equal(process.platform, "linux");
  const f = await createOperationalPrivatePipelineFixture(t), source = path.join(f.root, "candidate-60s-portrait.mp4");
  const generated = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "60", "-threads", "2", "-filter_threads", "1", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-b:v", "13M", "-minrate", "13M", "-maxrate", "13M", "-bufsize", "26M", "-x264-params", "nal-hrd=cbr:force-cfr=1",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-n", source], { cwd: f.root, timeoutMs: 180000 });
  assert.equal(generated.code, 0, "Synthetic candidate creation failed");
  const encodedBytes = await fs.readFile(source), inputLimitBytes = 100 * 1024 ** 2;
  assert.ok(encodedBytes.length >= 92 * 1024 ** 2 && encodedBytes.length <= inputLimitBytes - 8, `Encoded candidate bytes=${encodedBytes.length}`);
  // ISO-BMFF permits a top-level free-space box. It exercises the exact upload,
  // snapshot and reservation limit without altering coded frames or claiming
  // that padding is extra codec work. Complete supervised decoding below still
  // proves the representative 60-second 1080x1920/13Mbps source is valid.
  const padding = Buffer.alloc(inputLimitBytes - encodedBytes.length);
  padding.writeUInt32BE(padding.length, 0); padding.write("free", 4, 4, "ascii");
  const bytes = Buffer.concat([encodedBytes, padding]); assert.equal(bytes.length, inputLimitBytes);
  assert.equal(bytes.readUInt32BE(encodedBytes.length) + encodedBytes.length, inputLimitBytes);
  assert.equal(bytes.toString("ascii", encodedBytes.length + 4, encodedBytes.length + 8), "free");
  const started = performance.now(), ready = await f.prepareVideo({ bytes, selection: { kind: "video", targets: ["story", "reel"], audioMode: "original", shareToFeed: true } });
  t.diagnostic(JSON.stringify({ case: "linux-candidate-limit", sourceBytes: bytes.length, encodedSourceBytes: encodedBytes.length,
    freeBoxBytes: padding.length, width: 1080, height: 1920, seconds: 60,
    elapsedMs: Math.ceil(performance.now() - started), ready: ready.status.ready, status: ready.status.state, code: ready.status.errorCode }));
  const observations = [], rawPrepared = [], decodedVideoProofs = [];
  for (const name of await fs.readdir(f.executorRoot)) if (/^[a-f0-9-]{36}$/.test(name)) {
    const intent = JSON.parse(await fs.readFile(path.join(f.executorRoot, name, "request.json"), "utf8")), observation = await f.executor.observe(name);
    observations.push({ operation: intent.operation, state: observation.state, reason: observation.reason, elapsedMs: observation.elapsedMs,
      metrics: observation.metrics, limits: observation.limits, terminationProved: observation.termination?.proved });
    if (intent.operation === "prepare" && observation.state === "succeeded") rawPrepared.push(observation.result);
    if (intent.operation === "inspect_output" && intent.input.descriptor.mimeType === "video/mp4" && observation.state === "succeeded") decodedVideoProofs.push(observation.result);
  }
  t.diagnostic(JSON.stringify({ case: "linux-candidate-limit-processes", observations }));
  assert.equal(ready.status.ready, true, "Candidate must succeed under original180s/512MiB/1CPU bounds; failure is retained evidence, not a relaxed timeout");
  const actual = await f.actualFor(ready.assetId, ready.mediaRevision);
  assert.equal(rawPrepared.length, 1); assert.equal(decodedVideoProofs.length, 1, "Equivalent Story/Reel shares one physically decoded derivative");
  for (const variant of Object.values(actual.prepared.variants)) {
    assert.equal(variant.width, 1080); assert.equal(variant.height, 1920); assert.equal(variant.hasAudio, true);
    // Durable descriptors intentionally project durationSeconds, not the raw
    // preparer's progress field. Verify both evidence layers independently.
    assert.ok(Math.abs(variant.durationSeconds - 60) < 0.15);
  }
  for (const variant of Object.values(rawPrepared[0].variants)) assert.ok(Math.abs(variant.decodedEndSeconds - 60) < 0.15);
  assert.equal(decodedVideoProofs[0].decoded, true); assert.equal(decodedVideoProofs[0].hasAudio, true);
  assert.ok(Math.abs(decodedVideoProofs[0].durationSeconds - 60) < 0.15);
  t.diagnostic(JSON.stringify({ case: "linux-candidate-limit-duration-proofs", persistedSeconds: actual.prepared.variants.story.durationSeconds,
    preparedDecodedEndSeconds: rawPrepared[0].variants.story.decodedEndSeconds, finalDecodedSeconds: decodedVideoProofs[0].durationSeconds }));
  assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 0);
});
