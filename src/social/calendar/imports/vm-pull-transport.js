"use strict";
// Small control envelopes only. Existing task-scoped byte transfer remains the
// only media protocol. The VM never receives database or provider credentials.
const crypto = require("node:crypto"), https = require("node:https"), http = require("node:http");
const { isWorkflowPrivateJournal, UUID, HASH, fail } = require("./workflow-private-journal");
const PREFIX = "/internal/calendar-media/vm/", MAX = 4096, clients = new WeakSet();
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function keyBytes(key) { if (!Buffer.isBuffer(key) || key.length !== 32) fail("vm_key_invalid"); return Buffer.from(key); }
function originUrl(origin, controlled) { const u = new URL(origin); if (u.username || u.password || u.search || u.hash || u.pathname !== "/" ||
  !(u.protocol === "https:" || controlled === true && u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname))) fail("origin_invalid"); return u; }
function signature(key, workerId, action, time, length, sha) {
  const scoped = crypto.createHmac("sha256", key).update("calendar-vm-control-v1:" + workerId).digest();
  try { return crypto.createHmac("sha256", scoped).update(["POST", action, workerId, time, length, sha].join("\n")).digest("hex"); }
  finally { scoped.fill(0); }
}
function bodyValid(value, action, revision) {
  const keys = action === "poll" ? "agentId,bootId,requestId,runtimeRevision" : "agentId,bootId,executionId,offerBootId,runtimeRevision";
  if (!value || Object.keys(value).sort().join() !== keys || value.runtimeRevision !== revision ||
    !Object.entries(value).filter(([k]) => k !== "runtimeRevision").every(([, v]) => UUID.test(v || ""))) fail("vm_body_invalid");
}
function createVmPullRouter({ journal, key, accessPolicy, clock = Date.now, timeoutMs = 15000 }) {
  if (!isWorkflowPrivateJournal(journal) || journal.transport.kind !== "vm" || typeof accessPolicy?.resolve !== "function" ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail("configuration_invalid");
  const material = keyBytes(key), { workerId, runtimeRevision } = journal.transport; let active = 0;
  return Object.freeze({ async handle(req, res) {
    if (!String(req.url || "").startsWith(PREFIX)) return false;
    let admitted = false, timer;
    try {
      const action = req.url.slice(PREFIX.length), stamp = req.headers["x-vm-time"], sha = req.headers["x-vm-sha256"], sig = req.headers["x-vm-auth"];
      const length = Number(req.headers["content-length"]), at = Number(stamp);
      if (req.method !== "POST" || !["poll", "done"].includes(action) || req.headers["x-vm-worker"] !== workerId ||
        req.headers["transfer-encoding"] || !Number.isSafeInteger(length) || length < 2 || length > MAX || !Number.isSafeInteger(at) ||
        Math.abs(clock() - at) > 90000 || !HASH.test(sha || "") || !HASH.test(sig || "")) fail("vm_authentication_invalid");
      const expected = signature(material, workerId, action, stamp, length, sha);
      if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) fail("vm_authentication_invalid");
      if (active >= 2) fail("vm_control_busy"); active++; admitted = true;
      timer = setTimeout(() => { req.destroy(); res.destroy(); }, timeoutMs); timer.unref?.();
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > length) fail("vm_body_invalid"); chunks.push(c); }
      const bytes = Buffer.concat(chunks); if (size !== length || hash(bytes) !== sha) fail("vm_body_invalid");
      const value = JSON.parse(bytes.toString("utf8")); bodyValid(value, action, runtimeRevision);
      // An already claimed execution may reconcile after revocation, but a new
      // assignment may not be offered to a now-ineligible owner.
      let allowed = false;
      if (action === "poll") { try { await accessPolicy.resolve({ authenticated: true, ...journal.owner }); allowed = true; } catch (_) {} }
      const result = action === "poll" ? await journal.offerVm({ ...value, workerId, allowNew: allowed }) : await journal.completeVm({ ...value, workerId });
      if (res.destroyed) return true;
      const output = Buffer.from(JSON.stringify(result)); res.writeHead(200, { "content-type": "application/json", "content-length": output.length, "cache-control": "no-store" }); res.end(output);
    } catch (_) { if (!res.headersSent && !res.destroyed) { res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" }); res.end('{"error":"vm_control_unavailable"}'); } else res.destroy(); }
    finally { clearTimeout(timer); if (admitted) active--; }
    return true;
  } });
}
function createVmPullClient({ origin, key, workerId, runtimeRevision, allowLoopbackForTests = false }) {
  if (!UUID.test(workerId || "") || !HASH.test(runtimeRevision || "")) fail("vm_identity_invalid");
  const url = originUrl(origin, allowLoopbackForTests), material = keyBytes(key);
  async function request(action, input) {
    const body = { ...input, runtimeRevision }; bodyValid(body, action, runtimeRevision);
    const bytes = Buffer.from(JSON.stringify(body)), stamp = String(Date.now()), sha = hash(bytes);
    return new Promise((resolve, reject) => {
      let timer;
      const rejectClosed = () => reject(Object.assign(new Error("vm_control_unconfirmed"), { code: "vm_control_unconfirmed" }));
      const req = (url.protocol === "https:" ? https : http).request(new URL(PREFIX + action, url), { method: "POST", rejectUnauthorized: true,
        headers: { "content-type": "application/json", "content-length": bytes.length, "x-vm-worker": workerId, "x-vm-time": stamp, "x-vm-sha256": sha,
          "x-vm-auth": signature(material, workerId, action, stamp, bytes.length, sha) } }, res => {
        (async () => {
          if (res.statusCode !== 200) { res.resume(); fail("vm_control_unconfirmed"); }
          let size = 0; const chunks = []; for await (const c of res) { size += c.length; if (size > MAX) fail("vm_body_invalid"); chunks.push(c); }
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (action === "done") { if (!value || Object.keys(value).join() !== "terminal" || value.terminal !== true) fail("vm_response_invalid"); }
          else if (value !== null && !(Object.keys(value).join() === "blocked" && value.blocked === true) &&
            (!value || Object.keys(value).sort().join() !== "agentId,executionId,offerBootId,recoveryOnly,terminal" || ![value.agentId, value.executionId, value.offerBootId].every(v => UUID.test(v || "")) ||
              value.agentId !== input.agentId || typeof value.recoveryOnly !== "boolean" || typeof value.terminal !== "boolean")) fail("vm_response_invalid");
          return value;
        })().then(resolve, () => { res.destroy(); rejectClosed(); }).finally(() => clearTimeout(timer));
      });
      timer = setTimeout(() => req.destroy(), 15000); timer.unref?.(); req.once("close", () => clearTimeout(timer)); req.once("error", rejectClosed); req.end(bytes);
    });
  }
  const client = Object.freeze({ workerId, runtimeRevision, poll: input => request("poll", input), done: input => request("done", input) }); clients.add(client); return client;
}
module.exports = { createVmPullRouter, createVmPullClient, isVmPullClient: value => clients.has(value), originUrl, PREFIX };
