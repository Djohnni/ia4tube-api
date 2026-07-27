"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const jwt = require("jsonwebtoken");

const {
  FcmTokenSecurityError,
  createFcmTokenCrypto
} = require("../src/notifications/fcm-token-crypto");
const {
  atomicWriteJson,
  deactivateFcmTokens,
  decryptActiveFcmTokens,
  migrateLegacyFcmTokensFile,
  registerFcmToken,
  sha256Upper
} = require("../src/notifications/fcm-token-store");
const {
  redactLogValue
} = require("../src/security/log-redaction");

const repoDir = path.resolve(__dirname, "..");
const serverFile = path.join(repoDir, "server.js");
const syntheticToken = "synthetic-fcm-token-for-encryption-tests-only";
const jwtSecret = "synthetic-jwt-secret-at-least-thirty-two-characters";

function encodedKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function cryptoEnv({
  keyId = "synthetic-v1",
  encryptionKey = encodedKey(),
  hmacKey = encodedKey()
} = {}) {
  return {
    FCM_TOKEN_ACTIVE_KEY_ID: keyId,
    FCM_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({
      [keyId]: encryptionKey
    }),
    FCM_TOKEN_HMAC_KEYS_JSON: JSON.stringify({
      [keyId]: hmacKey
    })
  };
}

function assertSecurityError(code, callback) {
  assert.throws(
    callback,
    (error) => error instanceof FcmTokenSecurityError &&
      error.code === code
  );
}

function mutateEncoded(value) {
  const first = value[0] === "A" ? "B" : "A";
  return `${first}${value.slice(1)}`;
}

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

function request(port, route, {
  method = "GET",
  token = "",
  body
} = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = body === undefined
      ? null
      : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: route,
      method,
      headers: {
        Host: "ia4tube.test",
        "X-Forwarded-Proto": "https",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bodyBuffer ? {
          "Content-Type": "application/json",
          "Content-Length": String(bodyBuffer.length)
        } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          raw,
          json: raw ? JSON.parse(raw) : {}
        });
      });
    });
    req.once("error", reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function spawnServer(env) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: repoDir,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  return { child, output: () => output };
}

async function waitForServer(instance, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (instance.output().includes("API rodando na porta")) return;
    if (instance.child.exitCode !== null) {
      throw new Error("Synthetic server exited before readiness.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Synthetic server readiness timeout.");
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill();
  await Promise.race([
    new Promise((resolve) => instance.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (instance.child.exitCode === null) {
    instance.child.kill("SIGKILL");
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function run() {
  const env = cryptoEnv();
  const tokenCrypto = createFcmTokenCrypto({ env });
  const first = tokenCrypto.encryptToken(syntheticToken);
  const second = tokenCrypto.encryptToken(syntheticToken);

  assert.strictEqual(tokenCrypto.decryptToken(first), syntheticToken);
  assert.strictEqual(tokenCrypto.decryptToken(second), syntheticToken);
  assert.notStrictEqual(first.iv, second.iv);
  assert.notStrictEqual(first.ciphertext, second.ciphertext);
  assert.strictEqual(first.fingerprint, second.fingerprint);
  assert.strictEqual(first.format_version, 1);
  assert.strictEqual(first.key_id, "synthetic-v1");
  assert.strictEqual(Object.hasOwn(first, "token"), false);

  for (const field of ["ciphertext", "iv", "tag", "fingerprint"]) {
    const tampered = {
      ...first,
      [field]: mutateEncoded(first[field])
    };
    assert.throws(() => tokenCrypto.decryptToken(tampered));
  }

  assertSecurityError(
    "fcm_token_keys_missing",
    () => createFcmTokenCrypto({
      env: { FCM_TOKEN_ACTIVE_KEY_ID: "synthetic-v1" }
    })
  );
  const wrongCrypto = createFcmTokenCrypto({
    env: cryptoEnv({ keyId: "synthetic-v1" })
  });
  assert.throws(() => wrongCrypto.decryptToken(first));

  const rotationEncryptionV1 = encodedKey();
  const rotationHmacV1 = encodedKey();
  const rotationEncryptionV2 = encodedKey();
  const rotationHmacV2 = encodedKey();
  const rotationV1 = createFcmTokenCrypto({
    env: cryptoEnv({
      keyId: "rotation-v1",
      encryptionKey: rotationEncryptionV1,
      hmacKey: rotationHmacV1
    })
  });
  const rotationRecordV1 = rotationV1.encryptToken(syntheticToken);
  const rotationV2 = createFcmTokenCrypto({
    env: {
      FCM_TOKEN_ACTIVE_KEY_ID: "rotation-v2",
      FCM_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({
        "rotation-v1": rotationEncryptionV1,
        "rotation-v2": rotationEncryptionV2
      }),
      FCM_TOKEN_HMAC_KEYS_JSON: JSON.stringify({
        "rotation-v1": rotationHmacV1,
        "rotation-v2": rotationHmacV2
      })
    }
  });
  assert.strictEqual(
    rotationV2.decryptToken(rotationRecordV1),
    syntheticToken
  );
  assert.strictEqual(
    rotationV2.encryptToken(syntheticToken).key_id,
    "rotation-v2"
  );

  const cliente = {
    nome_time: "Empresa Sintetica",
    plano: "teste",
    notificacoes: { preferencia: "somente_teste", fcm_tokens: [] }
  };
  const firstRegistration = registerFcmToken({
    cliente,
    token: syntheticToken,
    platform: "android",
    now: "2026-07-26T20:00:00.000Z",
    tokenCrypto
  });
  const firstStoredIv = cliente.notificacoes.fcm_tokens[0].iv;
  const secondRegistration = registerFcmToken({
    cliente,
    token: syntheticToken,
    platform: "android",
    now: "2026-07-26T20:01:00.000Z",
    tokenCrypto
  });
  assert.strictEqual(firstRegistration.totalCount, 1);
  assert.strictEqual(secondRegistration.totalCount, 1);
  assert.strictEqual(secondRegistration.activeCount, 1);
  assert.notStrictEqual(
    cliente.notificacoes.fcm_tokens[0].iv,
    firstStoredIv
  );
  assert.deepStrictEqual(
    decryptActiveFcmTokens({ cliente, tokenCrypto }),
    [syntheticToken]
  );
  assert.strictEqual(
    JSON.stringify(cliente).includes(syntheticToken),
    false
  );

  const deactivation = deactivateFcmTokens({
    cliente,
    tokens: [syntheticToken],
    reason: "synthetic_invalid",
    tokenCrypto,
    now: "2026-07-26T20:02:00.000Z"
  });
  assert.strictEqual(deactivation.deactivated, 1);
  assert.deepStrictEqual(
    decryptActiveFcmTokens({ cliente, tokenCrypto }),
    []
  );

  const migrationDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-fcm-migration-")
  );
  const migrationFile = path.join(migrationDir, "clientes.json");
  const preservedPedido = {
    id: "pedido-sintetico",
    status: "somente_teste"
  };
  const legacyClientes = {
    "empresa-sintetica": {
      nome_time: "Empresa Sintetica",
      plano: "teste",
      pedido_evidencia: preservedPedido,
      notificacoes: {
        preferencia: "somente_teste",
        fcm_tokens: [{
          token: syntheticToken,
          platform: "android",
          ativo: true,
          atualizado_em: "2026-07-26T20:00:00.000Z"
        }]
      }
    }
  };
  writeJson(migrationFile, legacyClientes);

  const migration = migrateLegacyFcmTokensFile({
    filePath: migrationFile,
    expectedLegacySha256: sha256Upper(syntheticToken),
    expectedLegacyCount: 1,
    env
  });
  assert.strictEqual(migration.changed, true);
  assert.strictEqual(migration.migrated, 1);
  assert.deepStrictEqual(migration.storageBefore, {
    encrypted: 0,
    legacy: 1,
    active: 1,
    total: 1
  });
  assert.deepStrictEqual(migration.storageAfter, {
    encrypted: 1,
    legacy: 0,
    active: 1,
    total: 1
  });

  const migratedRaw = fs.readFileSync(migrationFile, "utf8");
  const migratedClientes = JSON.parse(migratedRaw);
  const migratedRecord =
    migratedClientes["empresa-sintetica"].notificacoes.fcm_tokens[0];
  assert.strictEqual(migratedRaw.includes(syntheticToken), false);
  assert.strictEqual(Object.hasOwn(migratedRecord, "token"), false);
  assert.strictEqual(
    tokenCrypto.decryptToken(migratedRecord),
    syntheticToken
  );
  assert.deepStrictEqual(
    migratedClientes["empresa-sintetica"].pedido_evidencia,
    preservedPedido
  );
  assert.strictEqual(
    migratedClientes["empresa-sintetica"].notificacoes.preferencia,
    "somente_teste"
  );
  assert.deepStrictEqual(
    fs.readdirSync(migrationDir).sort(),
    ["clientes.json"]
  );

  const wrongDigestFile = path.join(
    migrationDir,
    "clientes-wrong-digest.json"
  );
  writeJson(wrongDigestFile, legacyClientes);
  const wrongDigestOriginal = fs.readFileSync(wrongDigestFile, "utf8");
  assertSecurityError(
    "fcm_token_legacy_sha256_mismatch",
    () => migrateLegacyFcmTokensFile({
      filePath: wrongDigestFile,
      expectedLegacySha256: "A".repeat(64),
      expectedLegacyCount: 1,
      env
    })
  );
  assert.strictEqual(
    fs.readFileSync(wrongDigestFile, "utf8"),
    wrongDigestOriginal
  );

  const failureFile = path.join(migrationDir, "atomic-failure.json");
  const originalAtomicValue = { marker: "original-synthetic" };
  writeJson(failureFile, originalAtomicValue);
  assert.throws(() => atomicWriteJson(
    failureFile,
    { marker: "replacement-synthetic" },
    {
      beforeRename: () => {
        throw new Error("synthetic-before-rename-failure");
      }
    }
  ));
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(failureFile, "utf8")),
    originalAtomicValue
  );
  assert.deepStrictEqual(
    fs.readdirSync(migrationDir)
      .filter((name) => name.includes(".tmp")),
    []
  );

  const redacted = redactLogValue({
    token: syntheticToken,
    ciphertext: first.ciphertext,
    fingerprint: first.fingerprint,
    nested: {
      iv: first.iv,
      tag: first.tag
    }
  });
  assert.strictEqual(JSON.stringify(redacted).includes(syntheticToken), false);
  assert.strictEqual(JSON.stringify(redacted).includes(first.ciphertext), false);
  assert.strictEqual(JSON.stringify(redacted).includes(first.fingerprint), false);

  const port = await getFreePort();
  const serverDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-fcm-server-")
  );
  writeJson(path.join(serverDataDir, "clientes.json"), {
    "empresa-api-sintetica": {
      nome_time: "Empresa API Sintetica",
      ativo: true,
      notificacoes: {
        fcm_tokens: []
      }
    }
  });
  const serverEnv = {
    ...process.env,
    ...env,
    PORT: String(port),
    DATA_DIR: serverDataDir,
    NODE_ENV: "test",
    HTTPS_ENFORCE: "true",
    HTTPS_ALLOW_LOCAL_HTTP: "false",
    PUBLIC_API_BASE_URL: "https://ia4tube.test",
    JWT_SECRET: jwtSecret,
    BOT_RUNNER_TOKEN: "",
    BOT_RUNNER_TOKEN_NEXT: "",
    MP_ACCESS_TOKEN: "",
    OPENAI_API_KEY: "",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    FCM_MOCK: "true",
    FIREBASE_EXPECTED_PROJECT_ID: "",
    FIREBASE_SERVICE_ACCOUNT_JSON: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    FIREBASE_PROJECT_ID: "",
    FIREBASE_CLIENT_EMAIL: "",
    FIREBASE_PRIVATE_KEY: "",
    FCM_TOKEN_LEGACY_EXPECTED_SHA256: "",
    IA4TUBE_FREE_ART_ENABLED: "false"
  };
  const instance = spawnServer(serverEnv);
  try {
    await waitForServer(instance);
    const authToken = jwt.sign(
      { whatsapp: "empresa-api-sintetica" },
      jwtSecret,
      { expiresIn: "5m" }
    );
    const registerBody = {
      token: syntheticToken,
      platform: "android"
    };
    const firstResponse = await request(port, "/me/fcm-token", {
      method: "POST",
      token: authToken,
      body: registerBody
    });
    const secondResponse = await request(port, "/me/fcm-token", {
      method: "POST",
      token: authToken,
      body: registerBody
    });

    assert.strictEqual(firstResponse.status, 200);
    assert.strictEqual(secondResponse.status, 200);
    assert.strictEqual(firstResponse.json.tokens_ativos, 1);
    assert.strictEqual(secondResponse.json.tokens_ativos, 1);
    assert.strictEqual(firstResponse.raw.includes(syntheticToken), false);
    assert.strictEqual(secondResponse.raw.includes(syntheticToken), false);

    const persistedRaw = fs.readFileSync(
      path.join(serverDataDir, "clientes.json"),
      "utf8"
    );
    const persisted = JSON.parse(persistedRaw);
    const records =
      persisted["empresa-api-sintetica"].notificacoes.fcm_tokens;
    assert.strictEqual(records.length, 1);
    assert.strictEqual(persistedRaw.includes(syntheticToken), false);
    assert.deepStrictEqual(
      Object.keys(records[0]).sort(),
      [
        "ativo",
        "atualizado_em",
        "ciphertext",
        "fingerprint",
        "format_version",
        "iv",
        "key_id",
        "platform",
        "tag"
      ]
    );
    assert.strictEqual(instance.output().includes(syntheticToken), false);
  } finally {
    await stopServer(instance);
  }

  const savedFcmEnv = {
    FCM_DELIVERY_ENABLED: process.env.FCM_DELIVERY_ENABLED,
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED:
      process.env.FCM_AUTOMATIC_NOTIFICATIONS_ENABLED,
    FCM_TOKEN_ACTIVE_KEY_ID: process.env.FCM_TOKEN_ACTIVE_KEY_ID,
    FCM_TOKEN_ENCRYPTION_KEYS_JSON:
      process.env.FCM_TOKEN_ENCRYPTION_KEYS_JSON,
    FCM_TOKEN_HMAC_KEYS_JSON: process.env.FCM_TOKEN_HMAC_KEYS_JSON
  };
  let fetchCalls = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("synthetic-external-request-forbidden");
  };
  try {
    process.env.FCM_DELIVERY_ENABLED = "false";
    process.env.FCM_AUTOMATIC_NOTIFICATIONS_ENABLED = "false";
    delete process.env.FCM_TOKEN_ACTIVE_KEY_ID;
    delete process.env.FCM_TOKEN_ENCRYPTION_KEYS_JSON;
    delete process.env.FCM_TOKEN_HMAC_KEYS_JSON;
    const configPath = require.resolve("../src/notifications/fcm-config");
    const servicePath = require.resolve("../src/notifications/fcm.service");
    delete require.cache[configPath];
    delete require.cache[servicePath];
    const fcmService = require("../src/notifications/fcm.service");
    const blocked = await fcmService.sendToClient(
      migratedClientes["empresa-sintetica"],
      { title: "Synthetic", body: "Synthetic" }
    );
    assert.strictEqual(blocked.code, "fcm_delivery_disabled");
    assert.strictEqual(fetchCalls, 0);
  } finally {
    global.fetch = previousFetch;
    for (const [name, value] of Object.entries(savedFcmEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  fs.rmSync(migrationDir, { recursive: true, force: true });
  fs.rmSync(serverDataDir, { recursive: true, force: true });
  console.log("fcm-token-encryption.test.js ok");
}

run().catch((error) => {
  console.error({
    code: error?.code || "fcm_token_encryption_test_failed",
    message: "FCM token encryption test failed."
  });
  process.exit(1);
});
