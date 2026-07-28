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
const {
  finalTestDevicePath,
  readFinalTestDevice
} = require("../src/notifications/fcm-final-test");

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
  keyEnv,
  allowedOwner,
  tokenRegistrationEnabled = true
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
    FCM_TOKEN_REGISTRATION_ENABLED:
      tokenRegistrationEnabled ? "true" : "false",
    FCM_FINAL_TEST_ALLOWED_OWNER_SHA256: crypto
      .createHash("sha256")
      .update(allowedOwner, "utf8")
      .digest("hex"),
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
  const tokenA3 = "synthetic-fcm-contract-a-single-slot";
  const tokenB = "synthetic-fcm-contract-b";
  const deniedToken = "synthetic-forbidden-owner-token";
  const legacyA = "synthetic-legacy-owner-a-untouched";
  const legacyB = "synthetic-legacy-owner-b-untouched";
  const deniedMalformedMarker =
    "synthetic-denied-malformed-body-secret";
  const allowedMalformedMarker =
    "synthetic-allowed-malformed-body-secret";
  const jwtSecret = "synthetic-jwt-contract-secret-long-enough";
  const keyEnv = syntheticKeyEnv();
  const tokenCrypto = createFcmTokenCrypto({ env: keyEnv });
  const ownerAllowlist = crypto
    .createHash("sha256")
    .update(ownerA, "utf8")
    .digest("hex");
  const vaultEnv = {
    ...keyEnv,
    FCM_FINAL_TEST_ALLOWED_OWNER_SHA256: ownerAllowlist
  };
  let instance;

  try {
    writeJson(clientesFile, {
      [ownerA]: {
        nome_time: "Synthetic A",
        whatsapp: ownerA,
        notificacoes: {
          fcm_tokens: [{ token: legacyA, ativo: true }]
        }
      },
      [ownerB]: {
        nome_time: "Synthetic B",
        whatsapp: ownerB,
        notificacoes: {
          fcm_tokens: [{ token: legacyB, ativo: false }]
        }
      }
    });
    const clientesHashOriginal = sha256File(clientesFile);
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
      keyEnv,
      allowedOwner: ownerA
    });
    await waitUntilReady(instance);

    const jwtA = jwt.sign({ whatsapp: ownerA }, jwtSecret, {
      expiresIn: "5m"
    });
    const jwtB = jwt.sign({ whatsapp: ownerB }, jwtSecret, {
      expiresIn: "5m"
    });

    const deniedMalformed = await fetch(
      `http://127.0.0.1:${port}/ME/FCM-TOKEN`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwtB}`,
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https"
        },
        body: `{"token":"${deniedMalformedMarker}"`
      }
    );
    assert.equal(deniedMalformed.status, 403);

    const allowedMalformed = await fetch(
      `http://127.0.0.1:${port}/me/fcm-token/`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwtA}`,
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https"
        },
        body: `{"token":"${allowedMalformedMarker}"`
      }
    );
    assert.equal(allowedMalformed.status, 400);
    assert.equal(
      (await allowedMalformed.json()).code,
      "fcm_token_request_invalid"
    );

    const oversized = await fetch(
      `http://127.0.0.1:${port}/me/fcm-token////`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwtA}`,
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({
          token: "x".repeat(17 * 1024),
          platform: "android"
        })
      }
    );
    assert.equal(oversized.status, 413);
    assert.equal(
      (await oversized.json()).code,
      "fcm_token_payload_too_large"
    );

    const urlencodedAliasMarker =
      "synthetic-urlencoded-alias-secret";
    const urlencodedAlias = await fetch(
      `http://127.0.0.1:${port}/ME/FCM-TOKEN/`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwtA}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Forwarded-Proto": "https"
        },
        body: `token=${urlencodedAliasMarker}&platform=android`
      }
    );
    assert.equal(urlencodedAlias.status, 415);
    assert.equal(
      (await urlencodedAlias.json()).code,
      "fcm_token_content_type_invalid"
    );

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

    const singleSlot = await request(port, "/me/fcm-token", {
      method: "POST",
      jwtToken: jwtA,
      body: {
        token: tokenA3,
        platform: "android"
      }
    });
    assert.equal(singleSlot.status, 200);
    assert.equal(singleSlot.body.tokens_ativos, 1);
    const activeSingleSlotDevice = readFinalTestDevice({
      dataDir,
      env: vaultEnv
    });
    assert.equal(
      activeSingleSlotDevice.notificacoes.fcm_tokens.length,
      1
    );
    assert.deepEqual(
      decryptActiveFcmTokens({
        cliente: activeSingleSlotDevice,
        tokenCrypto
      }),
      [tokenA3]
    );

    const beforeDeniedOwner = sha256File(clientesFile);
    const deniedOwner = await request(port, "/me/fcm-token", {
      method: "POST",
      jwtToken: jwtB,
      body: {
        token: deniedToken,
        platform: "android"
      }
    });
    assert.deepEqual(deniedOwner, {
      status: 403,
      body: {
        ok: false,
        code: "fcm_final_test_owner_not_allowed",
        error: "Registro de notificacoes indisponivel."
      }
    });
    assert.equal(sha256File(clientesFile), beforeDeniedOwner);

    const deniedDelete = await request(port, "/me/fcm-token", {
      method: "DELETE",
      jwtToken: jwtB,
      body: { token: tokenB, platform: "android" }
    });
    assert.deepEqual(deniedDelete, {
      status: 403,
      body: {
        ok: false,
        code: "fcm_final_test_owner_not_allowed",
        error: "Registro de notificacoes indisponivel."
      }
    });
    assert.equal(sha256File(clientesFile), beforeDeniedOwner);

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
      body: { token: tokenA3, platform: "android" }
    });
    assert.deepEqual(deactivated, {
      status: 200,
      body: { ok: true, desativado: true }
    });
    const repeated = await request(port, "/me/fcm-token", {
      method: "DELETE",
      jwtToken: jwtA,
      body: { token: tokenA3, platform: "android" }
    });
    assert.deepEqual(repeated, {
      status: 200,
      body: { ok: true, desativado: false }
    });

    assert.equal(sha256File(clientesFile), clientesHashOriginal);
    const device = readFinalTestDevice({
      dataDir,
      env: vaultEnv
    });
    assert.deepEqual(
      decryptActiveFcmTokens({
        cliente: device,
        tokenCrypto
      }),
      []
    );
    const serialized = fs.readFileSync(
      finalTestDevicePath(dataDir),
      "utf8"
    );
    assert.equal(serialized.includes(tokenA1), false);
    assert.equal(serialized.includes(tokenA2), false);
    assert.equal(serialized.includes(tokenA3), false);
    assert.equal(serialized.includes(tokenB), false);
    assert.equal(instance.output().includes(tokenA1), false);
    assert.equal(instance.output().includes(tokenA2), false);
    assert.equal(instance.output().includes(tokenA3), false);
    assert.equal(instance.output().includes(tokenB), false);
    assert.equal(instance.output().includes(deniedToken), false);
    assert.equal(instance.output().includes(legacyA), false);
    assert.equal(instance.output().includes(legacyB), false);
    assert.equal(
      instance.output().includes(deniedMalformedMarker),
      false
    );
    assert.equal(
      instance.output().includes(allowedMalformedMarker),
      false
    );
    assert.equal(
      instance.output().includes(urlencodedAliasMarker),
      false
    );
    assert.equal(fs.existsSync(externalCallsFile), false);
    assert.deepEqual(
      fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp")),
      []
    );

    const vaultHashBeforeClosedGate = sha256File(
      finalTestDevicePath(dataDir)
    );
    await stopServer(instance);
    instance = null;
    const closedGatePort = await freePort();
    instance = spawnSyntheticServer({
      dataDir,
      port: closedGatePort,
      preloadFile,
      jwtSecret,
      keyEnv,
      allowedOwner: ownerA,
      tokenRegistrationEnabled: false
    });
    await waitUntilReady(instance);

    const closedGateMarkers = [
      "synthetic-closed-gate-exact",
      "synthetic-closed-gate-uppercase",
      "synthetic-closed-gate-trailing",
      "synthetic-closed-gate-urlencoded"
    ];
    const closedGateRequests = [
      ["/me/fcm-token", "application/json", `{"token":"${closedGateMarkers[0]}"`],
      ["/ME/FCM-TOKEN", "application/json", `{"token":"${closedGateMarkers[1]}"`],
      ["/me/fcm-token////", "application/json", JSON.stringify({
        token: closedGateMarkers[2].repeat(2_000),
        platform: "android"
      })],
      ["/ME/FCM-TOKEN/", "application/x-www-form-urlencoded",
        `token=${closedGateMarkers[3]}&platform=android`]
    ];
    for (const [pathname, contentType, body] of closedGateRequests) {
      const response = await fetch(
        `http://127.0.0.1:${closedGatePort}${pathname}`,
        {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            "X-Forwarded-Proto": "https"
          },
          body
        }
      );
      assert.equal(response.status, 503);
      assert.equal(
        (await response.json()).code,
        "fcm_token_registration_disabled"
      );
    }
    assert.equal(
      sha256File(finalTestDevicePath(dataDir)),
      vaultHashBeforeClosedGate
    );
    for (const marker of closedGateMarkers) {
      assert.equal(instance.output().includes(marker), false);
    }
    assert.equal(fs.existsSync(externalCallsFile), false);
  } finally {
    await stopServer(instance);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
