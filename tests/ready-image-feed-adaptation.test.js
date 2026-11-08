"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), os = require("node:os");
const sharp = require("sharp");
const { createReadyImageFeedAdapter, SETTINGS, PROMPT } = require("../src/company-edit-calendar/ready-image-feed-adaptation");
const { normalizeReadyImage } = require("../src/company-edit-calendar/ready-images");

function temp(t) {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, "ia4tube-feed-adapt-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith("ia4tube-feed-adapt-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}
async function image(width = 1152, height = 1440) {
  return sharp({ create: { width, height, channels: 3, background: "red" } }).png().toBuffer();
}
const response = bytes => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }],
  usage: { input_tokens: 111, output_tokens: 222, total_tokens: 333 } }), { status: 200 });

for (const [width, height, needs] of [[900, 1600, true], [1200, 1200, true], [1200, 600, true], [800, 1000, false]])
  test(`geometry ${width}x${height} is inspected before any generation`, async t => {
    const dir = temp(t), source = path.join(dir, "input.png"); fs.writeFileSync(source, await image(width, height));
    const decoded = await normalizeReadyImage({ path: source, mimetype: "image/png" }, { prepareFeed: true });
    assert.equal(decoded.needsAdaptation, needs);
    if (needs) {
      const meta = await sharp(decoded.feedSource).metadata();
      assert.deepEqual([meta.width, meta.height], [width, height]);
      assert.equal(meta.exif, undefined);
    } else assert.equal(decoded.feedSource, undefined);
  });

test("EXIF orientation is applied before checking the Feed ratio", async t => {
  const source = path.join(temp(t), "rotated.jpeg");
  await sharp(await image(1000, 800)).withMetadata({ orientation: 6 }).jpeg().toFile(source);
  const decoded = await normalizeReadyImage({ path: source, mimetype: "image/jpeg" }, { prepareFeed: true });
  assert.equal(decoded.needsAdaptation, false);
});

test("one POST uses the unframed source, existing model and one output; restart reuses the exact paid result", async t => {
  const directory = temp(t), input = await image(900, 1600), output = await image(); let calls = 0;
  const adapter = createReadyImageFeedAdapter({ apiKey: "synthetic-key", fetchImpl: async (url, request) => {
    calls++; assert.equal(url, "https://api.openai.com/v1/images/edits"); assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    for (const [key, value] of Object.entries(SETTINGS)) assert.equal(request.body.get(key), String(value));
    assert.equal(request.body.get("prompt"), PROMPT);
    assert.equal(request.body.getAll("image[]").length, 1);
    assert.deepEqual(Buffer.from(await request.body.get("image[]").arrayBuffer()), input);
    const journal = JSON.parse(fs.readFileSync(path.join(directory, "synthetic.feed-adaptation-v1/attempt.json")));
    assert.equal(journal.state, "requested"); assert.equal(journal.apiCalls, 1);
    return response(output);
  } });
  const staged = adapter.stage({ directory, id: "synthetic", sourceDigest: "abc", bytes: input });
  const first = await adapter.adapt(staged);
  const restarted = createReadyImageFeedAdapter({ fetchImpl: () => { throw Error("must not call"); } });
  assert.deepEqual(await restarted.adapt(staged), first); assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(first.path), output);
  const record = JSON.parse(fs.readFileSync(path.join(staged.folder, "attempt.json")));
  assert.equal(record.automaticRetry, false); assert.equal(record.apiCalls, 1);
  assert.equal(JSON.stringify(record).includes("synthetic-key"), false);
  assert.deepEqual(record.usage, { input_tokens: 111, output_tokens: 222, total_tokens: 333 });
});

for (const failure of ["network", "429", "wrong-size", "transparent", "invalid-json"])
  test(`${failure} preserves the attempt and never generates again on retry`, async t => {
    const directory = temp(t); let calls = 0;
    const adapter = createReadyImageFeedAdapter({ apiKey: "synthetic-key", fetchImpl: async () => {
      calls++;
      if (failure === "network") throw Error("synthetic timeout");
      if (failure === "429") return new Response("rate limit", { status: 429 });
      if (failure === "invalid-json") return new Response("invalid", { status: 200 });
      if (failure === "transparent") return response(await sharp({ create: {
        width: 1152, height: 1440, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
      return response(await image(100, 100));
    } });
    const staged = adapter.stage({ directory, id: "synthetic", sourceDigest: "abc", bytes: await image(900, 1600) });
    await assert.rejects(adapter.adapt(staged), { code: "edit_calendar_ready_image_adaptation_preserved" });
    await assert.rejects(adapter.adapt(staged), { code: "edit_calendar_ready_image_adaptation_preserved" });
    assert.equal(calls, 1);
    const record = JSON.parse(fs.readFileSync(path.join(staged.folder, "attempt.json")));
    assert.equal(record.state, "failed_or_uncertain"); assert.equal(record.apiCalls, 1);
    assert.ok(fs.existsSync(staged.source));
    if (["wrong-size", "transparent"].includes(failure)) assert.ok(fs.existsSync(path.join(staged.folder, "response.png")));
  });

test("an interrupted receipt after saving the output recovers bytes without a second POST", async t => {
  const directory = temp(t), adapter = createReadyImageFeedAdapter({ apiKey: "synthetic-key",
    fetchImpl: async () => response(await image()) });
  const staged = adapter.stage({ directory, id: "synthetic", sourceDigest: "abc", bytes: await image(900, 1600) });
  const first = await adapter.adapt(staged), journal = path.join(staged.folder, "attempt.json");
  const record = JSON.parse(fs.readFileSync(journal)); delete record.outputDigest; record.state = "requested";
  fs.writeFileSync(journal, JSON.stringify(record));
  const restarted = createReadyImageFeedAdapter({ fetchImpl: () => { throw Error("must not call"); } });
  assert.deepEqual(await restarted.adapt(staged), first);
  assert.equal(JSON.parse(fs.readFileSync(journal)).recovered, true);
});
