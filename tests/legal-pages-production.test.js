"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  LEGAL_PAGE_DEFINITIONS,
  loadLegalTemplates
} = require("../src/legal/legal-pages.routes");

const repoDir = path.resolve(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(child, output, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (output().includes("API rodando na porta")) return;
    if (child.exitCode !== null) {
      throw new Error(`Server exited before readiness: ${output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server readiness timeout: ${output()}`);
}

test("production server serves every legal alias publicly with approved template bytes", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-pages-production-"));
  const port = await freePort();
  const env = {
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    PORT: String(port),
    JWT_SECRET: "synthetic-legal-page-test-secret-longer-than-32",
    PUBLIC_API_BASE_URL: "https://synthetic.invalid",
    SOCIAL_PERSISTENCE_ENABLED: "false",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    FCM_SCHEDULED_NOTIFICATIONS_ENABLED: "false",
    IA4TUBE_ADMIN_FREE_ARTS_ENABLED: "false"
  };
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "NODE_PATH"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }

  const child = spawn(process.execPath, [path.join(repoDir, "server.js")], {
    cwd: repoDir,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert.ok(child.exitCode !== null || child.signalCode !== null, `Server did not stop: ${output}`);
  });

  await waitUntilReady(child, () => output);
  const templates = loadLegalTemplates();
  for (const definition of LEGAL_PAGE_DEFINITIONS) {
    for (const alias of definition.aliases) {
      const response = await fetch(`http://127.0.0.1:${port}${alias}`);
      assert.equal(response.status, 200, alias);
      assert.match(response.headers.get("content-type") || "", /^text\/html/i, alias);
      assert.equal(response.headers.get("cache-control"), "no-store", alias);
      assert.equal(response.headers.get("content-language"), "pt-BR", alias);
      assert.equal(response.headers.get("x-robots-tag"), "index,follow", alias);
      assert.equal(await response.text(), templates[definition.id], alias);
    }
  }
});
