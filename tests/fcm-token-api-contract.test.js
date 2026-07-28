"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const {
  FcmTokenApiContractError,
  parseDeactivateFcmTokenBody,
  parseRegisterFcmTokenBody
} = require("../src/notifications/fcm-token-api-contract");
const {
  createFcmTokenCrypto
} = require("../src/notifications/fcm-token-crypto");
const {
  decryptActiveFcmTokens
} = require("../src/notifications/fcm-token-store");

const repoDir = path.resolve(__dirname, "..");
const serverFile = path.join(repoDir, "server.js");

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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function syntheticKeyEnv() {
  const keyId = "synthetic-contract-v1";
  return {
    FCM_TOKEN_ACTIVE_KEY_ID: keyId,
    FCM_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({
      [keyId]: crypto.randomBytes(32).toString("base64url")
    }),
    FCM_TOKEN_HMAC_KEYS_JSON: JSON.stringify({
      [keyId]: crypto.randomBytes(32).toString("base64url")
    })
  };
}

async function waitUntilReady(instance, timeoutMs = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (instance.output().includes("API rodando na porta")) return;
    if (instance.child.exitCode !== null) {
      throw new Error(`synthetic server exited: ${instance.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("synthetic server readiness timeout");
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill();
  await Promise.race([
    new Promise((resolve) => instance.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
}

function spawnSyntheticServer({
  dataDir,
  port,
  preloadFile,
  jwtSecret,
  keyEnv
}) {
  const env = {
    ...process.env,
    ...keyEnv,
    NODE_ENV: "test",
    PORT: String(port),
    DATA_DIR: dataDir,
    JWT_SECRET: jwtSecret,
    BOT_RUNNER_TOKEN: "synthetic-bot-token-contract",
    BOT_ADMIN_WHATSAPP: "synthetic-admin",
    PUBLIC_API_BASE_URL: "https://synthetic.invalid",
    FCM_TOKEN_REGISTRATION_ENABLED: "true",
    FCM_ART_READY_EVENT_ENABLED: "false",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    FCM_STATUS_NOTIFICATIONS_ENABLED: "false",
    FCM_SCHEDULED_NOTIFICATIONS_ENABLED: "false",
    FCM_MANUAL_NOTIFICATIONS_ENABLED: "false",
    IA4TUBE_ADMIN_FREE_ARTS_ENABLED: "false",
    IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_ENABLED: "false",
    OPENAI_API_KEY: "",
    MP_ACCESS_TOKEN: "",
    FIREBASE_SERVICE_ACCOUNT_JSON: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    FIREBASE_PROJECT_ID: "",
    FIREBASE_CLIENT_EMAIL: "",
    FIREBASE_PRIVATE_KEY: ""
  };
  const child = spawn(
    process.execPath,
    ["--require", preloadFile, serverFile],
    {
      cwd: repoDir,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  return { child, output: () => output };
}

async function request(port, pathname, {
  method,
  jwtToken = "",
  body
}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Forwarded-Proto": "https"
  };
  if (jwtToken) headers.Authorization = `Bearer ${jwtToken}`;
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

test("FCM token request bodies are strict and Android-only", () => {
  assert.deepEqual(
    parseRegisterFcmTokenBody({
      token: "synthetic-current",
      platform: "android",
      previous_token: "synthetic-previous"
    }),
    {
      token: "synthetic-current",
      platform: "android",
      previousToken: "synthetic-previous"
    }
  );
  assert.deepEqual(
    parseDeactivateFcmTokenBody({
      token: "synthetic-current",
      platform: "android"
    }),
    {
      token: "synthetic-current",
      platform: "android"
    }
  );

  for (const body of [
    { token: "synthetic", platform: "ios" },
    { token: " synthetic", platform: "android" },
    { token: "synthetic token", platform: "android" },
    { token: "synthetic", platform: "android", owner: "forbidden" },
    { token: 123, platform: "android" }
  ]) {
    assert.throws(
      () => parseRegisterFcmTokenBody(body),
      (error) => error instanceof FcmTokenApiContractError
    );
  }
  assert.throws(
    () => parseDeactivateFcmTokenBody({
      token: "synthetic",
      platform: "android",
      reason: "forbidden"
    }),
    (error) => error instanceof FcmTokenApiContractError
  );
});

test("authenticated registration, replacement and deactivation are isolated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-fcm-contract-"));
  const dataDir = path.join(root, "data");
  const clientesFile = path.join(dataDir, "clientes.json");
  const externalCallsFile = path.join(root, "external-calls.log");
  const preloadFile = path.join(root, "network-guard.cjs");
  const ownerA = "synthetic-owner-contract-a";
  const ownerB = "synthetic-owner-contract-b";
  const tokenA1 = "synthetic-fcm-contract-a-one";
  const tokenA2 = "synthetic-fcm-contract-a-two";
  const tokenB = "synthetic-fcm-contract-b";
  const jwtSecret = "synthetic-jwt-contract-secret-long-enough";
  const keyEnv = syntheticKeyEnv();
  const tokenCrypto = createFcmTokenCrypto({ env: keyEnv });
  let instance;

  try {
    writeJson(clientesFile, {
      [ownerA]: { nome_time: "Synthetic A", whatsapp: ownerA },
      [ownerB]: { nome_time: "Synthetic B", whatsapp: ownerB }
    });
    fs.writeFileSync(
      preloadFile,
      [
        '"use strict";',
        'const fs = require("node:fs");',
        `const marker = ${JSON.stringify(externalCallsFile)};`,
        "global.fetch = async (...args) => {",
        "  fs.appendFileSync(marker, `${String(args[0])}\\n`, 'utf8');",
        "  throw new Error('external_request_forbidden');",
        "};"
      ].join("\n"),
      "utf8"
    );

    const port = await freePort();
    instance = spawnSyntheticServer({
      dataDir,
      port,
      preloadFile,
      jwtSecret,
      keyEnv
    });
    await waitUntilReady(instance);

    const jwtA = jwt.sign({ whatsapp: ownerA }, jwtSecret, {
      expiresIn: "5m"
    });
    const jwtB = jwt.sign({ whatsapp: ownerB }, jwtSecret, {
      expiresIn: "5m"
    });

    const unauthorized = await request(port, "/me/fcm-token", {
      method: "DELETE",
      body: { token: tokenA1, platform: "android" }
    });
    assert.equal(unauthorized.status, 401);

    const beforeInvalid = sha256File(clientesFile);
    const invalid = await request(port, "/me/fcm-token", {
      method: "POST",
      jwtToken: jwtA,
      body: {
        token: tokenA1,
        platform: "android",
        forbidden: true
      }
    });
    assert.equal(invalid.status, 400);
    assert.equal(sha256File(clientesFile), beforeInvalid);

    const first = await request(port, "/me/fcm-token", {
      method: "POST",
      jwtToken: jwtA,
      body: { token: tokenA1, platform: "android" }
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);

    const replaced = await request(port, "/me/fcm-token", {
      method: "POST",
      jwtToken: jwtA,
      body: {
        token: tokenA2,
        previous_token: tokenA1,
        platform: "android"
      }
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.ok, true);

    const registeredB = await request(port, "/me/fcm-token", {
      method: "POST",
      jwtToken: jwtB,
      body: { token: tokenB, platform: "android" }
    });
    assert.equal(registeredB.status, 200);

    const crossOwner = await request(port, "/me/fcm-token", {
      method: "DELETE",
      jwtToken: jwtA,
      body: { token: tokenB, platform: "android" }
    });
    assert.deepEqual(crossOwner, {
      status: 200,
      body: { ok: true, desativado: false }
    });

    const invalidDeleteHash = sha256File(clientesFile);
    const invalidDelete = await request(port, "/me/fcm-token", {
      method: "DELETE",
      jwtToken: jwtA,
      body: {
        token: tokenA2,
        platform: "android",
        reason: "forbidden"
      }
    });
    assert.equal(invalidDelete.status, 400);
    assert.equal(sha256File(clientesFile), invalidDeleteHash);

    const deactivated = await request(port, "/me/fcm-token", {
      method: "DELETE",
      jwtToken: jwtA,
      body: { token: tokenA2, platform: "android" }
    });
    assert.deepEqual(deactivated, {
      status: 200,
      body: { ok: true, desativado: true }
    });
    const repeated = await request(port, "/me/fcm-token", {
      method: "DELETE",
      jwtToken: jwtA,
      body: { token: tokenA2, platform: "android" }
    });
    assert.deepEqual(repeated, {
      status: 200,
      body: { ok: true, desativado: false }
    });

    const clientes = JSON.parse(fs.readFileSync(clientesFile, "utf8"));
    assert.deepEqual(
      decryptActiveFcmTokens({
        cliente: clientes[ownerA],
        tokenCrypto
      }),
      []
    );
    assert.deepEqual(
      decryptActiveFcmTokens({
        cliente: clientes[ownerB],
        tokenCrypto
      }),
      [tokenB]
    );
    const serialized = JSON.stringify(clientes);
    assert.equal(serialized.includes(tokenA1), false);
    assert.equal(serialized.includes(tokenA2), false);
    assert.equal(serialized.includes(tokenB), false);
    assert.equal(instance.output().includes(tokenA1), false);
    assert.equal(instance.output().includes(tokenA2), false);
    assert.equal(instance.output().includes(tokenB), false);
    assert.equal(fs.existsSync(externalCallsFile), false);
    assert.deepEqual(
      fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp")),
      []
    );
  } finally {
    await stopServer(instance);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
