"use strict";
const fs = require("node:fs/promises"), sync = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), https = require("node:https"), { once } = require("node:events");
const { UUID, HASH, fail, isWorkflowPrivateJournal } = require("./workflow-private-journal");
const { safePath, digest } = require("./media-process-executor");
const PREFIX = "/internal/calendar-media/workflow/", EMPTY = crypto.createHash("sha256").update("").digest("hex");
const MAX_BYTES = 100 * 1024 ** 2, MAX_JSON = 65536, MAX_CHUNK = 65536, bridges = new WeakSet(), clients = new WeakSet();
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function checkSignal(signal) { if (signal?.aborted) fail("transfer_deadline_or_closed"); }
function writeBounded(res, chunk, signal) {
  checkSignal(signal); if (res.destroyed) fail("transfer_closed");
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { res.off("drain", drain); res.off("close", gone); res.off("error", gone); signal?.removeEventListener("abort", gone); };
    const drain = () => { clean(); resolve(); }, gone = () => { clean(); reject(Object.assign(new Error("workflow_private_transfer_closed"), { code: "workflow_private_transfer_closed" })); };
    res.once("drain", drain); res.once("close", gone); res.once("error", gone); signal?.addEventListener("abort", gone, { once: true });
    if (res.destroyed || signal?.aborted) gone();
  });
}
function secret(value) { if (!Buffer.isBuffer(value) || value.length !== 32) fail("key_invalid"); return Buffer.from(value); }
function mac(key, id, method, resource, agentId, time, length, sha) {
  const scoped = crypto.createHmac("sha256", key).update("calendar-workflow-v1:" + id).digest();
  try { return crypto.createHmac("sha256", scoped).update([method, resource, agentId, time, length, sha].join("\n")).digest("hex"); }
  finally { scoped.fill(0); }
}
async function fileHash(filename, check = () => {}) {
  check();
  await safePath(filename, { file: true }); const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_BYTES) fail("file_invalid");
  const h = crypto.createHash("sha256"), stream = sync.createReadStream(filename, { highWaterMark: MAX_CHUNK, flags: sync.constants.O_RDONLY | (sync.constants.O_NOFOLLOW || 0) });
  const until = performance.now() + 60000;
  let size = 0; for await (const chunk of stream) { check(); if (performance.now() > until) fail("transfer_deadline"); size += chunk.length; if (size > stat.size) fail("file_changed"); h.update(chunk); }
  const after = await fs.lstat(filename);
  if (size !== stat.size || stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail("file_changed");
  return { sha256: h.digest("hex"), size };
}
async function readJson(stream, expected, sha) {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX_JSON) fail("body_invalid");
  const chunks = []; let length = 0;
  for await (const chunk of stream) { length += chunk.length; if (length > expected) fail("body_invalid"); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); if (length !== expected || hash(bytes) !== sha) fail("body_invalid");
  try { return bytes.length ? JSON.parse(bytes) : null; } catch (_) { fail("body_invalid"); }
}
async function receiveFile(stream, filename, expected, sha, check = () => {}) {
  check();
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_BYTES || !HASH.test(sha)) fail("file_invalid");
  await safePath(path.dirname(filename));
  try { const found = await fileHash(filename, check); if (found.size === expected && found.sha256 === sha) { stream.resume(); return; } fail("file_conflict"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temp = filename + ".partial-" + crypto.randomUUID(); const handle = await fs.open(temp, "wx", 0o600);
  let size = 0, h = crypto.createHash("sha256"), closed = false;
  try {
    for await (const chunk of stream) {
      check();
      size += chunk.length; if (size > expected) fail("file_too_large"); h.update(chunk);
      let offset = 0; while (offset < chunk.length) { const w = await handle.write(chunk, offset, Math.min(MAX_CHUNK, chunk.length - offset)); if (!w.bytesWritten) fail("write_failed"); offset += w.bytesWritten; }
    }
    check(); if (size !== expected || h.digest("hex") !== sha) fail("checksum_invalid");
    await handle.sync(); check(); await handle.close(); closed = true;
    try { await fs.link(temp, filename); } catch (error) { if (error.code !== "EEXIST") throw error; const prior = await fileHash(filename); if (prior.size !== expected || prior.sha256 !== sha) fail("file_conflict"); }
    await fs.chmod(filename, 0o400);
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(filename), sync.constants.O_RDONLY | (sync.constants.O_DIRECTORY || 0));
      try { await directory.sync(); check(); } finally { await directory.close(); }
    }
  } finally {
    if (!closed) await handle.close();
    // This request alone created this named staging file; its handle is closed.
    // No original, committed derivative or unknown execution is deleted.
    await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(filename), sync.constants.O_RDONLY | (sync.constants.O_DIRECTORY || 0));
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  check();
}
function allParts(prepared) { const items = [...Object.values(prepared?.variants || {}), ...(prepared?.thumbnail ? [prepared.thumbnail] : [])];
  if (items.length < 1 || items.length > 4) fail("manifest_invalid");
  const unique = new Map(); for (const p of items) { if (!HASH.test(p?.sha256 || "") || p.fileName !== p.sha256 + (p.mimeType === "image/jpeg" ? ".jpg" : ".mp4") ||
    !["image/jpeg", "video/mp4"].includes(p.mimeType) || !Number.isSafeInteger(p.size) || p.size < 1 || p.size > MAX_BYTES) fail("manifest_invalid");
    if (unique.has(p.sha256) && digest(unique.get(p.sha256)) !== digest(p)) fail("manifest_invalid"); unique.set(p.sha256, p); }
  return unique;
}
function createWorkflowPrivateBridge({ journal, provider, privateRoot, preparationRoot, key, getResultStore, assertHeld, resolveMusicTrack, musicRoot, clock = Date.now,
  allowSyntheticForTests = false, diagnostic = () => {}, transferTimeoutMs = 60000 } = {}) {
  if (!isWorkflowPrivateJournal(journal) || typeof provider?.streamSealedObject !== "function" || !path.isAbsolute(preparationRoot || "") || !path.isAbsolute(privateRoot || "") ||
    typeof getResultStore !== "function" || typeof assertHeld !== "function" || !Number.isSafeInteger(transferTimeoutMs) ||
    transferTimeoutMs < 1 || transferTimeoutMs > 60000) fail("configuration_invalid");
  const root = path.resolve(preparationRoot), material = secret(key); let active = 0;
  if (resolveMusicTrack !== undefined && (!path.isAbsolute(musicRoot || "") || path.resolve(musicRoot) === path.parse(path.resolve(musicRoot)).root)) fail("music_configuration_invalid");
  async function approvedMusic(record) {
    if (typeof resolveMusicTrack !== "function" || !record.task.selection?.musicTrackId) fail("music_unavailable");
    const m = await resolveMusicTrack(record.task.selection.musicTrackId, record.task.companyId);
    if (!m || m.synthetic && !allowSyntheticForTests || !HASH.test(m.sha256 || "") || !path.isAbsolute(m.filePath || "") ||
        path.dirname(path.resolve(m.filePath)) !== path.resolve(musicRoot) || !/\.(mp3|wav)$/i.test(m.filePath)) fail("music_unavailable");
    await safePath(path.resolve(musicRoot)); return m;
  }
  async function check(record, agentId, expired = false) {
    if (record.agentId !== agentId || !expired && (record.task.deadlineAt <= clock() || record.delivered)) fail("stale");
    if (!expired && await assertHeld(record.task, record.kind, record.resultRef) !== true) fail("admission_missing");
  }
  async function target(record, part, create = false) {
    let dir = root; await safePath(dir);
    for (const id of [record.task.companyId, record.task.assetId]) { if (!UUID.test(id || "")) fail("binding_invalid"); dir = path.join(dir, id);
      if (create) await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; }); await safePath(dir); }
    return path.join(dir, part.fileName);
  }
  async function finish(record) {
    if (record.delivered) return record.delivered;
    const m = record.manifest; if (!m || m.executionId !== record.executionId || m.termination?.proved !== true ||
      m.termination.descendants !== 0 || !HASH.test(m.termination.proofId || "") || !Number.isSafeInteger(m.elapsedMs) ||
      m.elapsedMs < 0 || m.elapsedMs > record.task.maxRuntimeMs) fail("result_invalid");
    if (record.kind === "prepare" && m.state === "succeeded") {
      const files = allParts(m.prepared);
      for (const part of files.values()) { const actual = await fileHash(await target(record, part)); if (actual.sha256 !== part.sha256 || actual.size !== part.size) fail("checksum_invalid"); }
      const store = getResultStore(); if (!require("./prepared-disk-store").isPreparedDiskResultStore(store)) fail("result_store_invalid");
      const query = Object.fromEntries(["companyId", "userId", "assetId", "mediaRevision", "dispatchKey", "executionDigest"].map(k => [k, record.task[k]])); query.resultRef = record.resultRef;
      let actual;
      try { actual = await store.inspectCommitted(query); } catch (_) {
        actual = await store.commit({ task: record.task, prepared: m.prepared, resultRef: record.resultRef, finishedAt: m.finishedAt, elapsedMs: m.elapsedMs }); }
      if (actual.resultRef !== record.resultRef) fail("result_conflict");
    }
    const delivered = { executionId: record.executionId, state: m.state, termination: m.termination, elapsedMs: m.elapsedMs,
      ...(m.state === "succeeded" ? record.kind === "inspect" ? { result: m.result } : { resultRef: record.resultRef } : {}) };
    return journal.deliver(record.executionId, record.agentId, delivered);
  }
  function json(res, status, value) { const bytes = Buffer.from(JSON.stringify(value)); res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": bytes.length }); res.end(bytes); }
  const bridge = Object.freeze({ journal, capabilities: Object.freeze({ privateOnly: true, taskScoped: true, noPublicSignedUrls: true, allowSyntheticForTests }),
    async inspectFile({ filePath, descriptor }) {
      // Branded receipt verifier consumed by the existing immutable result store.
      // Bound directory, full bytes and descriptor must all match a received,
      // authenticated manifest produced by real supervised output inspection.
      const relative = path.relative(path.resolve(privateRoot), filePath).split(path.sep);
      if (relative.length !== 4 || relative[0] !== journal.owner.companyId) fail("inspection_invalid");
      const records = await journal.records();
      for (const r of records) { if (!r.manifest?.inspections || r.task.assetId !== relative[1]) continue;
        const p = allParts(r.manifest.prepared).get(descriptor.sha256);
        // The existing result store deliberately projects canonical fields
        // (e.g. excludes UI-only composition). Every projected field must match.
        if (!p || Object.keys(descriptor).some(k => p[k] === undefined || digest(p[k]) !== digest(descriptor[k])) ||
            r.dispatchKey !== relative[2] || path.join(path.resolve(privateRoot), r.task.companyId, r.task.assetId, r.dispatchKey, p.fileName) !== filePath) continue;
        const observed = await fileHash(filePath); if (observed.sha256 !== p.sha256 || observed.size !== p.size) fail("checksum_invalid");
        const proof = r.manifest.inspections[p.sha256]; if (!proof || proof.decoded !== true || proof.sha256 !== p.sha256 || proof.sizeBytes !== p.size) fail("inspection_invalid");
        const { sha256, sizeBytes, ...inspection } = proof; return inspection;
      } fail("inspection_missing");
    },
    async recover(executionId) { const r = await journal.get(executionId); return r.delivered || (r.manifest ? finish(r) : null); },
    async handle(req, res) {
      if (!String(req.url).startsWith(PREFIX)) return false;
      let accepted = false, taskTimer;
      const controller = new AbortController(), signal = controller.signal, stop = () => { controller.abort(); req.destroy(); if (!res.writableFinished) res.destroy(); };
      const timer = setTimeout(stop, transferTimeoutMs); timer.unref?.();
      const disconnected = () => { if (!res.writableFinished) controller.abort(); };
      res.once("close", disconnected); res.once("error", disconnected); req.once("aborted", disconnected);
      try {
        const match = new RegExp("^" + PREFIX + "([a-f0-9-]{36})/(claim|source|music|manifest|complete|status|part/[a-f0-9]{64})$").exec(req.url);
        if (!match || !UUID.test(match[1])) fail("request_invalid");
        const [, id, resource] = match, agent = req.headers["x-media-agent"], stamp = req.headers["x-media-time"], sha = req.headers["x-media-sha256"], signature = req.headers["x-media-auth"];
        const length = Number(req.headers["content-length"] || 0), at = Number(stamp);
        if (!UUID.test(agent || "") || !Number.isSafeInteger(at) || Math.abs(clock() - at) > 90000 || !HASH.test(sha || "") || !HASH.test(signature || "") ||
            !Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES || req.headers["transfer-encoding"]) fail("authentication_invalid");
        const expected = mac(material, id, req.method, resource, agent, stamp, length, sha);
        if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) fail("authentication_invalid");
        if (active >= 2) fail("transfer_busy"); active++; accepted = true; req.setTimeout(60000, () => req.destroy());
        let record = await journal.get(id);
        checkSignal(signal);
        if (!["status", "complete"].includes(resource)) {
          const left = record.task.deadlineAt - clock(); if (left <= 0) fail("stale");
          taskTimer = setTimeout(stop, Math.min(transferTimeoutMs, left)); taskTimer.unref?.();
        }
        if (resource === "claim" && req.method === "POST") { const body = await readJson(req, length, sha); if (body !== null) fail("body_invalid");
          record = await journal.claim(id, agent); await check(record, agent);
          let music;
          if (record.task.selection?.musicTrackId) {
            const m = await approvedMusic(record);
            music = { sourceName: "track" + path.extname(m.filePath).toLowerCase(), sha256: m.sha256, synthetic: m.synthetic === true, ...(m.rights ? { rights: m.rights } : {}) };
          }
          json(res, 200, { kind: record.kind, task: record.task, resultRef: record.resultRef, ...(music ? { music } : {}) }); return true; }
        await check(record, agent, resource === "status" || resource === "complete" && Boolean(record.delivered));
        if (resource === "status" && req.method === "GET") { if (length || sha !== EMPTY) fail("body_invalid"); json(res, 200, { delivered: Boolean(record.delivered) }); return true; }
        if ((resource === "source" || resource === "music") && req.method === "GET") {
          if (length || sha !== EMPTY) fail("body_invalid");
          let source = record.kind === "inspect" ? record.task : record.task.source;
          if (resource === "music") {
            if (!record.task.selection?.musicTrackId || typeof resolveMusicTrack !== "function") fail("music_unavailable");
            const music = await approvedMusic(record);
            const actual = await fileHash(music.filePath); if (actual.sha256 !== music.sha256) fail("music_changed");
            res.writeHead(200, { "content-type": "application/octet-stream", "content-length": actual.size, "x-media-sha256": actual.sha256, "cache-control": "no-store" });
            const stream = sync.createReadStream(music.filePath, { highWaterMark: MAX_CHUNK });
            const abort = () => stream.destroy(); signal.addEventListener("abort", abort, { once: true });
            try { for await (const c of stream) await writeBounded(res, c, signal); } finally { signal.removeEventListener("abort", abort); stream.destroy(); }
            checkSignal(signal); res.end(); return true;
          }
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": source.sizeBytes, "x-media-sha256": source.sha256, "cache-control": "no-store" });
          await provider.streamSealedObject({ context: { authenticated: true, companyId: record.task.companyId, userId: record.task.userId },
            objectKey: source.objectKey, objectVersion: source.objectVersion,
            consume: async c => { checkSignal(signal); if (c.length > MAX_CHUNK) fail("chunk_invalid"); await writeBounded(res, c, signal); } }); checkSignal(signal); res.end(); return true;
        }
        if (resource === "manifest" && req.method === "POST") {
          const m = await readJson(req, length, sha);
          if (!m || m.executionId !== id || !["succeeded", "failed"].includes(m.state) || m.termination?.proved !== true || m.termination.descendants !== 0 ||
              !HASH.test(m.termination.proofId || "") || m.state === "succeeded" && record.kind === "prepare" &&
              (m.prepared?.sourceSha256 !== record.task.source.sha256 || !m.inspections)) fail("manifest_invalid");
          if (record.kind === "prepare" && m.state === "succeeded") {
            const parts = allParts(m.prepared);
            if ([...parts.values()].reduce((n, p) => n + p.size, 0) > record.task.reservedOutputBytes) fail("manifest_too_large");
          }
          checkSignal(signal); await journal.manifest(id, agent, m); json(res, 200, { accepted: true }); return true;
        }
        if (resource.startsWith("part/") && req.method === "PUT") {
          const part = allParts(record.manifest?.prepared).get(resource.slice(5));
          if (!part || length !== part.size || sha !== part.sha256) fail("part_invalid");
          await receiveFile(req, await target(record, part, true), length, sha, () => checkSignal(signal)); json(res, 200, { accepted: true }); return true;
        }
        if (resource === "complete" && req.method === "POST") { if (await readJson(req, length, sha) !== null) fail("body_invalid");
          checkSignal(signal); await finish(record); json(res, 200, { delivered: true }); return true; }
        fail("request_invalid");
      } catch (error) { diagnostic(/^[a-z_]{1,100}$/.test(error?.code || "") ? error.code : "workflow_transfer_incomplete"); if (!res.headersSent) json(res, 409, { error: "workflow_private_unavailable" }); else res.destroy(); return true; }
      finally { clearTimeout(timer); clearTimeout(taskTimer); res.off("close", disconnected); res.off("error", disconnected); req.off("aborted", disconnected); if (accepted) active--; }
    }
  }); bridges.add(bridge); return bridge;
}
function createWorkflowPrivateClient({ origin, key, executionId, agentId = crypto.randomUUID(), allowLoopbackForTests = false }) {
  const url = new URL(origin); if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || url.protocol === "http:" && allowLoopbackForTests && ["127.0.0.1", "[::1]"].includes(url.hostname))) fail("origin_invalid");
  if (!UUID.test(executionId || "") || !UUID.test(agentId)) fail("binding_invalid"); const material = secret(key);
  async function request(method, resource, { data, file, destination, expected } = {}) {
    if (!/^(claim|source|music|manifest|complete|status|part\/[a-f0-9]{64})$/.test(resource)) fail("request_invalid");
    const bytes = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data)); if (bytes.length > MAX_JSON) fail("body_invalid");
    const info = file ? await fileHash(file) : { size: bytes.length, sha256: hash(bytes) }, stamp = String(Date.now());
    const headers = { "content-length": info.size, "x-media-agent": agentId, "x-media-time": stamp, "x-media-sha256": info.sha256,
      "x-media-auth": mac(material, executionId, method, resource, agentId, stamp, info.size, info.sha256) };
    return new Promise((resolve, reject) => {
      let timer;
      const req = (url.protocol === "https:" ? https : http).request(new URL(PREFIX + executionId + "/" + resource, url),
        { method, headers, timeout: 60000, rejectUnauthorized: true }, res => {
          (async () => {
            if (res.statusCode !== 200) { res.resume(); fail("request_rejected"); }
            const length = Number(res.headers["content-length"]), sha = res.headers["x-media-sha256"];
            if (destination) { if (!HASH.test(sha || "") || expected && (length !== expected.sizeBytes || sha !== expected.sha256)) fail("source_invalid");
              await receiveFile(res, destination, length, sha); return { sizeBytes: length, sha256: sha }; }
            const chunks = []; let size = 0; for await (const c of res) { size += c.length; if (size > MAX_JSON) fail("body_invalid"); chunks.push(c); }
            return JSON.parse(Buffer.concat(chunks).toString("utf8"));
          })().then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); res.destroy(); reject(Object.assign(new Error("workflow_private_transfer_failed"), { code: "workflow_private_transfer_failed" })); });
        });
      timer = setTimeout(() => req.destroy(), 60000); timer.unref?.(); req.once("close", () => clearTimeout(timer));
      req.on("timeout", () => req.destroy()); req.on("error", () => reject(Object.assign(new Error("workflow_private_transfer_failed"), { code: "workflow_private_transfer_failed" })));
      if (file) { const stream = sync.createReadStream(file, { highWaterMark: MAX_CHUNK }); stream.on("error", () => req.destroy()); req.on("close", () => stream.destroy()); stream.pipe(req); }
      else req.end(bytes);
    });
  }
  const client = Object.freeze({ executionId, agentId, claim: () => request("POST", "claim"), source: (destination, expected) => request("GET", "source", { destination, expected }),
    music: destination => request("GET", "music", { destination }), manifest: data => request("POST", "manifest", { data }),
    part: (sha, file) => request("PUT", "part/" + sha, { file }), complete: () => request("POST", "complete"), status: () => request("GET", "status") });
  clients.add(client); return client;
}
module.exports = { createWorkflowPrivateBridge, createWorkflowPrivateClient, isWorkflowPrivateBridge: b => bridges.has(b),
  isWorkflowPrivateClient: c => clients.has(c), fileHash, allParts, PREFIX };
