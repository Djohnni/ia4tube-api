"use strict";

// This host is only a synthetic mount of the unchanged production pause modules.
// It never loads the business server, credentials, queues or external providers.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const overlay = process.env.PAUSE_OVERLAY_ROOT;
function need(value) { if (!value) throw new Error("physical_host_refused"); }
need(process.platform === "linux" && process.getuid() === 0 && process.env.IA4TUBE_LINUX_PHYSICAL === "1" &&
  process.env.DATA_DIR === "/var/data" && typeof overlay === "string" && path.isAbsolute(overlay));
const maintenance = path.join(overlay, "src/maintenance");
require(path.join(maintenance, "pause-marker")).assertNoUnfinishedPause({ dataDir: "/var/data" });
const { createPauseRuntime } = require(path.join(maintenance, "pause-runtime"));
const { startLocalControl } = require(path.join(maintenance, "local-control"));
const express = createRequire(path.join(overlay, "package.json"))("express");
const runtime = createPauseRuntime({ enabled: true });
const app = express();
app.disable("x-powered-by");
app.use(runtime.admission);
app.get("/", (_req, res) => res.json({ ok: true, synthetic: true }));
app.post("/synthetic-write", async (_req, res) => {
  await fs.appendFile("/var/data/synthetic-ongoing.txt", "synthetic admitted HTTP write\n");
  res.json({ ok: true });
});
app.use((_error, _req, res, _next) => res.status(500).json({ ok: false, code: "synthetic_failure" }));
runtime.finalizeRouting(app);
const gates = new Map();
let control, server;
function reply(id, value) { if (process.connected) process.send({ id, ...value }); }
async function command(message) {
  need(message && Number.isSafeInteger(message.id) && typeof message.command === "string" && Object.keys(message).length === 2);
  const name = message.command;
  if (name === "start-writer" || name === "start-detached") {
    need(!gates.has(name));
    let release, complete;
    const wait = new Promise(resolve => { release = resolve; });
    const completion = new Promise(resolve => { complete = resolve; });
    const operation = async () => {
      try { await wait; await fs.appendFile("/var/data/synthetic-ongoing.txt", name === "start-writer" ? "synthetic in-flight write\n" : "synthetic detached write\n"); }
      finally { complete(); }
    };
    gates.set(name, { release, completion });
    if (name === "start-writer") void runtime.controller.run("synthetic-existing", operation).catch(() => {});
    else runtime.deferred("synthetic-detached", operation);
    // The deferred lease must already be admitted before this reply is sent.
    return reply(message.id, { ok: true, status: runtime.controller.status() });
  }
  if (name === "release-writer" || name === "release-detached") {
    const key = name.replace("release-", "start-"), gate = gates.get(key);
    need(gate); gate.release(); await gate.completion; gates.delete(key);
    return reply(message.id, { ok: true });
  }
  if (name === "status") return reply(message.id, { ok: true, status: runtime.controller.status() });
  if (name === "shutdown") {
    need(gates.size === 0);
    await control.close();
    await new Promise(resolve => server.close(resolve));
    reply(message.id, { ok: true });
    process.disconnect();
    return;
  }
  throw new Error("physical_host_refused");
}
process.on("message", message => { void command(message).catch(() => reply(message?.id, { ok: false, code: "physical_host_refused" })); });
(async () => {
  control = await startLocalControl({ runtime, dataDir: "/var/data" });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  process.send({ ready: true, pid: process.pid, port: server.address().port, epoch: runtime.controller.status().epoch });
})().catch(() => { process.exitCode = 1; if (process.connected) { process.send({ ready: false, code: "physical_host_refused" }); process.disconnect(); } });
