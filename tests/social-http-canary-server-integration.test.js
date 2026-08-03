"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const {
  HTTP_CANARY_ROUTE
} = require("../src/social/http-canary-availability");

const ROOT = path.resolve(__dirname, "..");
const SYNTHETIC_RUNNER_TOKEN = "R".repeat(64);
const SYNTHETIC_JWT_SECRET = "J".repeat(64);
const SYNTHETIC_MEDIA_SECRET = "M".repeat(64);

function minimalProcessEnvironment() {
  const env = {};
  for (const name of [
    "COMSPEC",
    "HOME",
    "LOCALAPPDATA",
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR"
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: pathname,
      headers
    }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

async function waitForServer(child, port, logs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error("Synthetic production-identity server exited early.");
    }
    try {
      const status = await request(port, "/");
      if (status > 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Synthetic server timeout (${logs.length} log chunks).`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

test("the real server keeps the canary route absent on a production service identity even if the flag is copied", async (t) => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-http-canary-production-identity-")
  );
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...minimalProcessEnvironment(),
      PORT: String(port),
      NODE_ENV: "production",
      RENDER: "true",
      RENDER_SERVICE_ID: "srv-synthetic-production",
      RENDER_SERVICE_NAME: "ia4tube-api",
      RENDER_SERVICE_TYPE: "web",
      RENDER_GIT_BRANCH: "main",
      DATA_DIR: dataDir,
      PUBLIC_API_BASE_URL: "https://synthetic-api.example.test",
      JWT_SECRET: SYNTHETIC_JWT_SECRET,
      ORDER_MEDIA_SIGNING_SECRET: SYNTHETIC_MEDIA_SECRET,
      BOT_ADMIN_WHATSAPP: "synthetic-admin",
      BOT_RUNNER_TOKEN: SYNTHETIC_RUNNER_TOKEN,
      SOCIAL_RUNTIME_HTTP_CANARY_ENABLED: "true",
      SOCIAL_PERSISTENCE_ENABLED: "false",
      HTTPS_ENFORCE: "false",
      HTTPS_ALLOW_LOCAL_HTTP: "true",
      FCM_TOKEN_REGISTRATION_ENABLED: "false",
      FCM_ART_READY_EVENT_ENABLED: "false",
      FCM_DELIVERY_ENABLED: "false",
      FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
      FCM_MOCK: "false",
      MP_ACCESS_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  t.after(async () => {
    await stopServer(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(child, port, logs);
  const status = await request(port, HTTP_CANARY_ROUTE, {
    Authorization: `Bearer ${SYNTHETIC_RUNNER_TOKEN}`,
    "Idempotency-Key": "p".repeat(32)
  });
  assert.equal(status, 404);
  const output = logs.join("");
  assert.equal(output.includes(SYNTHETIC_RUNNER_TOKEN), false);
  assert.equal(output.includes(SYNTHETIC_JWT_SECRET), false);
  assert.equal(output.includes(SYNTHETIC_MEDIA_SECRET), false);
});
