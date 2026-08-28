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
  CONTROLLED_GATE4_JPEG_SHA256,
  CONTROLLED_GATE4_PUBLIC_PATH,
  CONTROLLED_GATE4_STAGING_ORIGIN,
  isControlledGate4RequestPath,
  isControlledGate4StagingOrigin,
  normalizeControlledGate4RequestPath
} = require("../src/social/publication/controlled-gate4-jpeg");

const ROOT = path.resolve(__dirname, "..");
const SERVER_FILE = path.join(ROOT, "server.js");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function spawnServer(port, dataDirectory) {
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDirectory,
    NODE_ENV: "test",
    HTTPS_ENFORCE: "true",
    HTTPS_ALLOW_LOCAL_HTTP: "false",
    PUBLIC_API_BASE_URL: "https://ia4tube.test",
    JWT_SECRET: "gate4-server-asset-test-secret-with-at-least-32-characters",
    BOT_ADMIN_WHATSAPP: "gate4-server-test-admin",
    BOT_RUNNER_TOKEN: "",
    BOT_RUNNER_TOKEN_NEXT: "",
    MP_ACCESS_TOKEN: "",
    OPENAI_API_KEY: "",
    FCM_MOCK: "1",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    IA4TUBE_FREE_ART_ENABLED: "false",
    SOCIAL_PERSISTENCE_ENABLED: "false",
    SOCIAL_INSTAGRAM_ENABLED: "false",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false"
  };
  const child = spawn(process.execPath, [SERVER_FILE], {
    cwd: ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  return Object.freeze({ child, output: () => output });
}

async function waitForServer(instance, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (instance.output().includes("API rodando na porta")) return;
    if (instance.child.exitCode !== null) {
      throw new Error(
        `Gate 4 asset server exited before startup: ${instance.output()}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Gate 4 asset server did not start in time.");
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method: "GET",
      headers: {
        Host: "ia4tube.test",
        "X-Forwarded-Proto": "https"
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Object.freeze({
        body: Buffer.concat(chunks),
        status: response.statusCode
      })));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("Gate 4 origin and path normalization close equivalent static paths", () => {
  assert.equal(isControlledGate4StagingOrigin(CONTROLLED_GATE4_STAGING_ORIGIN), true);
  assert.equal(isControlledGate4StagingOrigin(`${CONTROLLED_GATE4_STAGING_ORIGIN}/`), true);
  assert.equal(isControlledGate4StagingOrigin(` ${CONTROLLED_GATE4_STAGING_ORIGIN} `), true);
  assert.equal(isControlledGate4StagingOrigin("https://ia4tube.test"), false);

  for (const requestPath of [
    CONTROLLED_GATE4_PUBLIC_PATH,
    `/social//gate4/${CONTROLLED_GATE4_JPEG_SHA256}.jpg`,
    `/social/%67ate4/${CONTROLLED_GATE4_JPEG_SHA256}.jpg`,
    `/social/gate4/../gate4/${CONTROLLED_GATE4_JPEG_SHA256}.jpg`
  ]) {
    assert.equal(isControlledGate4RequestPath(requestPath), true);
    assert.equal(
      normalizeControlledGate4RequestPath(requestPath),
      CONTROLLED_GATE4_PUBLIC_PATH
    );
  }
});

test("server returns 404 for the Gate 4 asset outside the exact staging origin", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-gate4-server-asset-")
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(dataDirectory, "clientes.json"),
    "{}",
    "utf8"
  );
  const port = await getFreePort();
  const instance = spawnServer(port, dataDirectory);
  t.after(async () => {
    if (instance.child.exitCode === null) {
      const exited = new Promise((resolve) => instance.child.once("exit", resolve));
      instance.child.kill();
      await exited;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitForServer(instance);

  for (const requestPath of [
    CONTROLLED_GATE4_PUBLIC_PATH,
    `/social//gate4/${CONTROLLED_GATE4_JPEG_SHA256}.jpg`,
    `/social/%67ate4/${CONTROLLED_GATE4_JPEG_SHA256}.jpg`,
    `/social/gate4/../gate4/${CONTROLLED_GATE4_JPEG_SHA256}.jpg`
  ]) {
    const response = await request(port, requestPath);
    assert.equal(response.status, 404, requestPath);
    assert.equal(
      response.body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
      false,
      requestPath
    );
  }
});
