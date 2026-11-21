"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { atomicWriteJson } = require("../notifications/fcm-token-store");

const MODEL = "gpt-image-2.5-sunburst";
const WIDTH = 1024;
const HEIGHT = 1536;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const OWNER_KEY = /^[a-f0-9]{64}$/;

function fail(code, statusCode) {
  throw Object.assign(new Error(code), { code: "assistant_" + code, statusCode });
}

function createWelcomeArt({ root, apiKey, fetchImpl = globalThis.fetch, canRun = () => true }) {
  const inProgress = new Set();
  const queued = new Map();
  let timer = null;
  let started = false;
  const directory = key => path.join(root, key);
  const receipt = key => path.join(directory(key), "receipt.json");
  const output = key => path.join(directory(key), "arte.png");

  function load(key) {
    if (!fs.existsSync(receipt(key))) return null;
    return JSON.parse(fs.readFileSync(receipt(key), "utf8"));
  }

  function state(key) {
    const job = load(key);
    if (!job) return { status: apiKey ? "available" : "unavailable" };
    if (fs.existsSync(output(key))) return { status: "ready", downloaded: job.downloaded === true };
    if (!apiKey || (job.status === "generating" && !inProgress.has(key)) || job.status === "unavailable")
      return { status: "unavailable", message: "A arte grátis precisa de ajuda para ser concluída." };
    return { status: job.status };
  }

  function reserve(key, { owner, draftId, revision, photoId, photos, logo, instructions }) {
    const prior = load(key);
    if (prior) {
      if (prior.draftId !== draftId || prior.revision !== revision || prior.photoId !== photoId)
        fail("preview_already_used", 409);
      return state(key);
    }
    if (!apiKey) fail("preview_unavailable", 503);
    if (!Buffer.isBuffer(logo) || !logo.length) fail("logo_required", 422);
    if (!photos.length || photos.length > 4) fail("photo_invalid", 400);
    fs.mkdirSync(directory(key), { recursive: true, mode: 0o700 });
    const sources = photos.map((photo, index) => {
      const filename = `foto-${index + 1}.png`;
      fs.writeFileSync(path.join(directory(key), filename), photo, { mode: 0o600 });
      return filename;
    });
    fs.writeFileSync(path.join(directory(key), "logo.png"), logo, { mode: 0o600 });
    sources.push("logo.png");
    const job = { owner, draftId, revision, photoId, sources, instructions, status: "queued" };
    atomicWriteJson(receipt(key), job);
    queued.set(key, job);
    if (started) queueMicrotask(tick);
    return state(key);
  }

  function image(key) {
    if (state(key).status !== "ready") fail("preview_not_ready", 404);
    return fs.createReadStream(output(key));
  }

  function downloaded(key) {
    if (state(key).status !== "ready") fail("preview_not_ready", 404);
    const job = load(key);
    if (!job.downloaded) atomicWriteJson(receipt(key), { ...job, status: "ready", downloaded: true });
    return state(key);
  }

  async function processJob(key, job) {
    atomicWriteJson(receipt(key), { ...job, status: "generating" });
    try {
      if (!canRun(job.owner)) fail("session_required", 401);
      const form = new FormData();
      form.set("model", MODEL);
      form.set("quality", "low");
      form.set("size", `${WIDTH}x${HEIGHT}`);
      form.set("output_format", "png");
      form.set("background", "opaque");
      form.set("n", "1");
      form.set("prompt", job.instructions);
      for (const source of job.sources) {
        const input = await sharp(path.join(directory(key), source), { limitInputPixels: 30e6 })
          .resize(768, 768, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
        form.append("image[]", new Blob([input], { type: "image/png" }), source);
      }
      const response = await fetchImpl("https://api.openai.com/v1/images/edits", {
        method: "POST", headers: { Authorization: "Bearer " + apiKey },
        body: form, redirect: "error", signal: AbortSignal.timeout(150000)
      });
      if (!response.ok) {
        await response.body?.cancel();
        // A rate limit is a definitive refusal. Retry at most twice and never retry an uncertain response.
        if (response.status === 429 && (job.rateLimits || 0) < 2) {
          const retry = { ...job, status: "queued",
            rateLimits: (job.rateLimits || 0) + 1, nextAttempt: Date.now() + 60000 };
          atomicWriteJson(receipt(key), retry);
          queued.set(key, retry);
          return;
        }
        fail("preview_unavailable", 503);
      }
      const { data, usage } = await response.json();
      const encoded = data?.[0]?.b64_json;
      if (typeof encoded !== "string" || encoded.length > MAX_RESPONSE_BYTES) fail("preview_unavailable", 503);
      const decoder = sharp(Buffer.from(encoded, "base64"), { limitInputPixels: WIDTH * HEIGHT, failOn: "error" });
      const metadata = await decoder.metadata();
      if (metadata.width !== WIDTH || metadata.height !== HEIGHT || (metadata.pages || 1) !== 1)
        fail("preview_unavailable", 503);
      const file = output(key), temporary = file + ".partial";
      fs.writeFileSync(temporary, await decoder.png().toBuffer(), { mode: 0o600 });
      fs.renameSync(temporary, file);
      atomicWriteJson(receipt(key), { ...job, status: "ready", usage });
    } catch {
      // If there is uncertainty, keep the receipt and do not make another potentially billable call.
      atomicWriteJson(receipt(key), { ...job, status: "unavailable" });
    }
  }

  function tick() {
    if (!started) return;
    for (const [key, job] of queued) {
      if (inProgress.size >= 2) return;
      if (inProgress.has(key) || job.nextAttempt > Date.now()) continue;
      queued.delete(key);
      inProgress.add(key);
      processJob(key, job).catch(() => {}).finally(() => {
        inProgress.delete(key);
        queueMicrotask(tick);
      });
    }
  }

  function start() {
    if (started || !apiKey) return;
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !OWNER_KEY.test(entry.name)) continue;
        try {
          const job = load(entry.name);
          if (job?.status === "queued") queued.set(entry.name, job);
        } catch { continue; }
      }
    }
    started = true;
    timer = setInterval(tick, 10000);
    timer.unref();
    queueMicrotask(tick);
  }

  function close() {
    started = false;
    if (timer) clearInterval(timer);
  }

  return { state, reserve, image, downloaded, start, close };
}

module.exports = { createWelcomeArt };
