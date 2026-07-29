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

const repoDir = path.resolve(__dirname, "..");
const serverFile = path.join(repoDir, "server.js");

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
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
  botToken,
  botAdmin,
  tokenRegistrationEnabled = false,
  artReadyEventEnabled = false,
  omitFcmGates = false,
  allowedOwner = ""
}) {
  const blockedNames = [
    "OPENAI_API_KEY",
    "MP_ACCESS_TOKEN",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "FCM_TOKEN_ACTIVE_KEY_ID",
    "FCM_TOKEN_ENCRYPTION_KEYS_JSON",
    "FCM_TOKEN_HMAC_KEYS_JSON"
  ];
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    DATA_DIR: dataDir,
    JWT_SECRET: jwtSecret,
    BOT_RUNNER_TOKEN: botToken,
    BOT_ADMIN_WHATSAPP: botAdmin,
    PUBLIC_API_BASE_URL: "https://synthetic.invalid",
    FCM_TOKEN_REGISTRATION_ENABLED:
      tokenRegistrationEnabled ? "true" : "false",
    FCM_ART_READY_EVENT_ENABLED:
      artReadyEventEnabled ? "true" : "false",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    FCM_FINAL_TEST_ALLOWED_OWNER_SHA256: allowedOwner
      ? crypto
          .createHash("sha256")
          .update(allowedOwner, "utf8")
          .digest("hex")
      : "",
    IA4TUBE_ADMIN_FREE_ARTS_ENABLED: "false",
    IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_ENABLED: "false"
  };
  if (omitFcmGates) {
    delete env.FCM_TOKEN_REGISTRATION_ENABLED;
    delete env.FCM_ART_READY_EVENT_ENABLED;
    delete env.FCM_DELIVERY_ENABLED;
    delete env.FCM_AUTOMATIC_NOTIFICATIONS_ENABLED;
  }
  for (const name of blockedNames) env[name] = "";

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

test("disabled gates preserve upload contract and create no notification state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-fcm-off-route-"));
  const dataDir = path.join(root, "data");
  const externalCallsFile = path.join(root, "external-calls.log");
  const preloadFile = path.join(root, "network-guard.cjs");
  const owner = "synthetic-owner-route";
  const month = "2026-07";
  const orderId = "synthetic-order-route";
  const orderDir = path.join(dataDir, "pedidos", owner, month, orderId);
  const clientesFile = path.join(dataDir, "clientes.json");
  const jwtSecret = "synthetic-jwt-secret-long-enough-for-route-test";
  const botToken = "synthetic-bot-token-route-test";
  const botAdmin = "synthetic-admin";
  const fcmToken = "synthetic-fcm-token-route-test-never-persist";
  let instance;

  try {
    fs.mkdirSync(orderDir, { recursive: true });
    writeJson(clientesFile, {
      [owner]: {
        nome_time: "Empresa Sintetica",
        whatsapp: owner
      }
    });
    writeJson(path.join(orderDir, "pedido.json"), {
      id: orderId,
      whatsapp: owner,
      status: "em_producao",
      product_id: "arte_empresa",
      categoria: "arte_empresa"
    });
    fs.writeFileSync(
      path.join(orderDir, "status.txt"),
      "em_producao",
      "utf8"
    );
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

    const clientesHashBefore = sha256File(clientesFile);
    const port = await freePort();
    instance = spawnSyntheticServer({
      dataDir,
      port,
      preloadFile,
      jwtSecret,
      botToken,
      botAdmin,
      omitFcmGates: true
    });
    await waitUntilReady(instance);

    const loginToken = jwt.sign({ whatsapp: owner }, jwtSecret, {
      expiresIn: "5m"
    });
    const registration = await fetch(
      `http://127.0.0.1:${port}/me/fcm-token`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${loginToken}`,
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({
          token: fcmToken,
          platform: "android"
        })
      }
    );
    const registrationBody = await registration.json();
    assert.equal(registration.status, 503);
    assert.equal(
      registrationBody.code,
      "fcm_token_registration_disabled"
    );
    assert.equal(sha256File(clientesFile), clientesHashBefore);

    const deactivation = await fetch(
      `http://127.0.0.1:${port}/me/fcm-token`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${loginToken}`,
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({
          token: fcmToken,
          platform: "android",
          forbidden_field_must_not_be_read: true
        })
      }
    );
    const deactivationBody = await deactivation.json();
    assert.equal(deactivation.status, 503);
    assert.equal(
      deactivationBody.code,
      "fcm_token_registration_disabled"
    );
    assert.equal(sha256File(clientesFile), clientesHashBefore);

    const resultadoBytes = Buffer.from(
      "synthetic-result-image-content",
      "utf8"
    );
    const previewBytes = Buffer.from(
      "synthetic-preview-image-content",
      "utf8"
    );
    const form = new FormData();
    form.append(
      "resultado",
      new Blob([resultadoBytes], { type: "image/png" }),
      "synthetic-result.png"
    );
    form.append(
      "preview",
      new Blob([previewBytes], { type: "image/jpeg" }),
      "synthetic-preview.jpg"
    );
    form.append("descricao_instagram", "Legenda sintetica");

    const startedAt = Date.now();
    const upload = await fetch(
      `http://127.0.0.1:${port}/bot/pedidos/${orderId}/upload-resultado`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${botToken}`,
          "X-Forwarded-Proto": "https"
        },
        body: form
      }
    );
    const elapsedMs = Date.now() - startedAt;
    const uploadBody = await upload.json();
    assert.equal(upload.status, 200);
    assert.deepEqual(uploadBody, {
      ok: true,
      arquivo: "resultado_final.png",
      preview: "preview_ia4tube.jpg"
    });
    assert.ok(elapsedMs < 3_000, `synthetic upload took ${elapsedMs} ms`);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const pedido = JSON.parse(
      fs.readFileSync(path.join(orderDir, "pedido.json"), "utf8")
    );
    assert.equal(pedido.status, "pronto");
    assert.equal(pedido.descricao_instagram, "Legenda sintetica");
    assert.equal(pedido.aprovado_cliente, false);
    assert.equal(pedido.baixado_cliente, false);
    assert.equal(Object.hasOwn(pedido, "art_ready_generation_id"), false);
    assert.equal(
      fs.readFileSync(path.join(orderDir, "status.txt"), "utf8"),
      "pronto"
    );
    assert.deepEqual(
      fs.readFileSync(path.join(orderDir, "resultado_final.png")),
      resultadoBytes
    );
    assert.deepEqual(
      fs.readFileSync(path.join(orderDir, "preview_ia4tube.jpg")),
      previewBytes
    );

    assert.equal(
      fs.existsSync(path.join(dataDir, "notifications")),
      false
    );
    assert.equal(
      fs.existsSync(path.join(dataDir, "art-ready-outbox.json")),
      false
    );
    assert.equal(fs.existsSync(externalCallsFile), false);
    assert.equal(sha256File(clientesFile), clientesHashBefore);
    assert.equal(instance.output().includes(fcmToken), false);
    assert.equal(instance.output().includes(botToken), false);

    await stopServer(instance);
    instance = null;

    const orderMismatchId = "synthetic-order-owner-mismatch";
    const mismatchDir = path.join(
      dataDir,
      "pedidos",
      owner,
      month,
      orderMismatchId
    );
    fs.mkdirSync(mismatchDir, { recursive: true });
    writeJson(path.join(mismatchDir, "pedido.json"), {
      id: orderMismatchId,
      whatsapp: "different-synthetic-owner",
      status: "em_producao",
      product_id: "arte_empresa",
      categoria: "arte_empresa"
    });
    fs.writeFileSync(
      path.join(mismatchDir, "status.txt"),
      "em_producao",
      "utf8"
    );

    const secondPort = await freePort();
    instance = spawnSyntheticServer({
      dataDir,
      port: secondPort,
      preloadFile,
      jwtSecret,
      botToken,
      botAdmin,
      tokenRegistrationEnabled: true,
      artReadyEventEnabled: true,
      allowedOwner: owner
    });
    await waitUntilReady(instance);

    const missingKeysRegistration = await fetch(
      `http://127.0.0.1:${secondPort}/me/fcm-token`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${loginToken}`,
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({
          token: fcmToken,
          platform: "android"
        })
      }
    );
    const missingKeysBody = await missingKeysRegistration.json();
    assert.equal(missingKeysRegistration.status, 503);
    assert.equal(
      missingKeysBody.code,
      "fcm_token_secure_storage_unavailable"
    );
    assert.equal(sha256File(clientesFile), clientesHashBefore);

    const mismatchForm = new FormData();
    mismatchForm.append(
      "resultado",
      new Blob([resultadoBytes], { type: "image/png" }),
      "synthetic-owner-mismatch.png"
    );
    const mismatchUpload = await fetch(
      `http://127.0.0.1:${secondPort}/bot/pedidos/${orderMismatchId}/upload-resultado`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${botToken}`,
          "X-Forwarded-Proto": "https"
        },
        body: mismatchForm
      }
    );
    assert.equal(mismatchUpload.status, 404);
    const mismatchPedido = JSON.parse(
      fs.readFileSync(path.join(mismatchDir, "pedido.json"), "utf8")
    );
    assert.equal(mismatchPedido.status, "em_producao");
    assert.equal(
      fs.existsSync(path.join(mismatchDir, "resultado_final.png")),
      false
    );
    assert.equal(
      Object.hasOwn(mismatchPedido, "art_ready_generation_id"),
      false
    );
    assert.equal(fs.existsSync(path.join(dataDir, "notifications")), false);
    assert.equal(fs.existsSync(externalCallsFile), false);
    assert.equal(instance.output().includes(fcmToken), false);
    assert.equal(instance.output().includes(botToken), false);
  } finally {
    await stopServer(instance);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
