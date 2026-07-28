"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  FcmConfigurationError,
  validateFcmRuntimeConfig
} = require("../src/notifications/fcm-config");
const {
  createFcmTokenCrypto
} = require("../src/notifications/fcm-token-crypto");
const {
  registerFcmToken
} = require("../src/notifications/fcm-token-store");
const {
  createGenerationId
} = require("../src/notifications/art-ready-notification.service");

const FCM_ENV_NAMES = [
  "FCM_TOKEN_REGISTRATION_ENABLED",
  "FCM_ART_READY_EVENT_ENABLED",
  "FCM_DELIVERY_ENABLED",
  "FCM_AUTOMATIC_NOTIFICATIONS_ENABLED",
  "FCM_STATUS_NOTIFICATIONS_ENABLED",
  "FCM_SCHEDULED_NOTIFICATIONS_ENABLED",
  "FCM_MANUAL_NOTIFICATIONS_ENABLED",
  "FCM_MOCK",
  "FIREBASE_EXPECTED_PROJECT_ID",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FCM_TOKEN_ACTIVE_KEY_ID",
  "FCM_TOKEN_ENCRYPTION_KEYS_JSON",
  "FCM_TOKEN_HMAC_KEYS_JSON"
];

function withFcmEnv(env, callback) {
  const previous = Object.fromEntries(
    FCM_ENV_NAMES.map((name) => [name, process.env[name]])
  );
  for (const name of FCM_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, env);

  const configPath = require.resolve("../src/notifications/fcm-config");
  const servicePath = require.resolve("../src/notifications/fcm.service");
  delete require.cache[configPath];
  delete require.cache[servicePath];

  return Promise.resolve()
    .then(() => callback(require("../src/notifications/fcm.service")))
    .finally(() => {
      delete require.cache[configPath];
      delete require.cache[servicePath];
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
}

test("all four FCM gates are closed when absent or not exactly true", () => {
  for (const value of [undefined, "", "TRUE", "1", "yes"]) {
    const env = value === undefined
      ? {}
      : {
          FCM_TOKEN_REGISTRATION_ENABLED: value,
          FCM_ART_READY_EVENT_ENABLED: value,
          FCM_DELIVERY_ENABLED: value,
          FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: value
        };
    const config = validateFcmRuntimeConfig(env);
    assert.equal(config.tokenRegistrationEnabled, false);
    assert.equal(config.artReadyEventEnabled, false);
    assert.equal(config.deliveryEnabled, false);
    assert.equal(config.automaticNotificationsEnabled, false);
    assert.equal(config.statusNotificationsEnabled, false);
    assert.equal(config.scheduledNotificationsEnabled, false);
    assert.equal(config.manualNotificationsEnabled, false);
    assert.equal(config.serviceAccount, null);
  }
});

test("art-ready gates do not unlock status, schedulers or manual endpoint", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const config = validateFcmRuntimeConfig({
    FCM_TOKEN_REGISTRATION_ENABLED: "true",
    FCM_ART_READY_EVENT_ENABLED: "true",
    FCM_DELIVERY_ENABLED: "true",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "true",
    FCM_STATUS_NOTIFICATIONS_ENABLED: "false",
    FCM_SCHEDULED_NOTIFICATIONS_ENABLED: "false",
    FCM_MANUAL_NOTIFICATIONS_ENABLED: "false",
    FIREBASE_EXPECTED_PROJECT_ID: "synthetic-project",
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: "synthetic-project",
      client_email: "synthetic@example.invalid",
      private_key: privateKey
    })
  });

  assert.equal(config.statusNotificationsEnabled, false);
  assert.equal(config.scheduledNotificationsEnabled, false);
  assert.equal(config.manualNotificationsEnabled, false);
});

test("disabled delivery never reads or validates configured credential material", () => {
  let fileReads = 0;
  let credentialEnvReads = 0;
  const env = new Proxy(
    {
      FCM_DELIVERY_ENABLED: "false",
      GOOGLE_APPLICATION_CREDENTIALS: "synthetic-missing.json",
      FIREBASE_SERVICE_ACCOUNT_JSON: "{malformed",
      FIREBASE_PROJECT_ID: "partial-only",
      FIREBASE_EXPECTED_PROJECT_ID: "synthetic-project"
    },
    {
      get(target, property) {
        if (
          String(property).startsWith("FIREBASE_") ||
          property === "GOOGLE_APPLICATION_CREDENTIALS"
        ) {
          credentialEnvReads += 1;
          throw new Error("credential environment must not be inspected");
        }
        return target[property];
      }
    }
  );
  const config = validateFcmRuntimeConfig(
    env,
    {
      fileSystem: {
        existsSync() {
          fileReads += 1;
          throw new Error("credential file must not be inspected");
        },
        readFileSync() {
          fileReads += 1;
          throw new Error("credential file must not be inspected");
        }
      }
    }
  );
  assert.equal(config.deliveryEnabled, false);
  assert.equal(config.credentialConfigured, false);
  assert.equal(config.serviceAccount, null);
  assert.equal(fileReads, 0);
  assert.equal(credentialEnvReads, 0);
});

test("enabled delivery fails closed without one valid matching credential", () => {
  assert.throws(
    () => validateFcmRuntimeConfig({
      FCM_DELIVERY_ENABLED: "true"
    }),
    (error) =>
      error instanceof FcmConfigurationError &&
      error.code === "fcm_credentials_missing"
  );

  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  assert.throws(
    () => validateFcmRuntimeConfig({
      FCM_DELIVERY_ENABLED: "true",
      FIREBASE_EXPECTED_PROJECT_ID: "synthetic-expected",
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        project_id: "synthetic-other",
        client_email: "synthetic@example.invalid",
        private_key: privateKey
      })
    }),
    (error) =>
      error instanceof FcmConfigurationError &&
      error.code === "fcm_project_mismatch"
  );
});

test("delivery gate precedes token decryption, OAuth, mock and network", async () => {
  let externalRequests = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    externalRequests += 1;
    throw new Error("external network forbidden");
  };
  try {
    await withFcmEnv({
      FCM_DELIVERY_ENABLED: "false",
      FCM_MOCK: "true",
      FIREBASE_SERVICE_ACCOUNT_JSON: "{malformed",
      GOOGLE_APPLICATION_CREDENTIALS: "synthetic-missing.json"
    }, async (service) => {
      const result = await service.sendToClient(
        {
          notificacoes: {
            fcm_tokens: [{
              token: "synthetic-legacy-plaintext-must-not-be-read",
              ativo: true
            }]
          }
        },
        { title: "Synthetic", body: "Synthetic" }
      );
      assert.equal(result.code, "fcm_delivery_disabled");
      assert.equal(service.tokenRegistrationEnabled(), false);
      assert.equal(service.artReadyEventEnabled(), false);
      assert.equal(service.automaticNotificationsEnabled(), false);
      assert.equal(service.statusNotificationsEnabled(), false);
      assert.equal(service.scheduledNotificationsEnabled(), false);
      assert.equal(service.manualNotificationsEnabled(), false);
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(externalRequests, 0);
});

test("art-ready transport uses one synthetic token and exact data-only body", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const keyId = "synthetic-transport-v1";
  const tokenKeyEnv = {
    FCM_TOKEN_ACTIVE_KEY_ID: keyId,
    FCM_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({
      [keyId]: crypto.randomBytes(32).toString("base64url")
    }),
    FCM_TOKEN_HMAC_KEYS_JSON: JSON.stringify({
      [keyId]: crypto.randomBytes(32).toString("base64url")
    })
  };
  const tokenCrypto = createFcmTokenCrypto({ env: tokenKeyEnv });
  const cliente = {};
  registerFcmToken({
    cliente,
    token: "synthetic-transport-token",
    tokenCrypto
  });
  const eventId = createGenerationId();
  const pedidoId = "synthetic-order-transport";
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com")) {
      return {
        ok: true,
        json: async () => ({
          access_token: "synthetic-access-token",
          expires_in: 3600
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ name: "synthetic-message-id" })
    };
  };

  try {
    await withFcmEnv({
      ...tokenKeyEnv,
      FCM_ART_READY_EVENT_ENABLED: "true",
      FCM_DELIVERY_ENABLED: "true",
      FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "true",
      FIREBASE_EXPECTED_PROJECT_ID: "synthetic-project",
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        project_id: "synthetic-project",
        client_email: "synthetic@example.invalid",
        private_key: privateKey
      })
    }, async (service) => {
      const result = await service.sendArtReadyToClient(
        cliente,
        { eventId, pedidoId }
      );
      assert.equal(result.ok, true);
      assert.equal(result.sent, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  const fcmRequest = requests.find((item) =>
    item.url.includes("fcm.googleapis.com")
  );
  assert.ok(fcmRequest);
  assert.deepEqual(JSON.parse(fcmRequest.options.body), {
    message: {
      token: "synthetic-transport-token",
      data: {
        schema_version: "1",
        tipo: "arte_pronta",
        event_id: eventId,
        pedido_id: pedidoId,
        title: "Sua arte está pronta!",
        body: "Toque para visualizar sua criação na IA4Tube."
      },
      android: {
        priority: "high"
      }
    }
  });
});

test("candidate contains no staging-only identifiers and schedulers are gated", () => {
  const repoDir = path.resolve(__dirname, "..");
  const files = [
    "server.js",
    "src/notifications/fcm-config.js",
    "src/notifications/fcm-token-crypto.js",
    "src/notifications/fcm-token-store.js",
    "src/notifications/fcm-token-api-contract.js",
    "src/notifications/fcm.service.js",
    "src/notifications/art-ready-contract.js",
    "src/notifications/art-ready-generation.js",
    "src/notifications/art-ready-notification.service.js",
    "src/notifications/art-ready-outbox.js"
  ];
  const source = files
    .map((file) => fs.readFileSync(path.join(repoDir, file), "utf8"))
    .join("\n");
  const bannedProjectId = ["ia4tube", "staging", "checkpoint", "a"].join("-");
  const bannedHost =
    `${["ia4tube-api", "staging", "checkpoint", "a"].join("-")}.onrender.com`;

  assert.equal(source.includes(bannedProjectId), false);
  assert.equal(source.includes(bannedHost), false);
  assert.match(
    source,
    /if \(fcmService\.scheduledNotificationsEnabled\(\)\) \{[\s\S]*setTimeout\(runMonthlyPlanningNotifications/
  );
  assert.match(
    source,
    /async function runMonthlyPlanningNotifications\(\) \{\s*if \(!fcmService\.scheduledNotificationsEnabled\(\)\) return;/
  );
  assert.match(
    source,
    /async function runFreeArtCampaignNotifications\(\) \{\s*if \(!fcmService\.scheduledNotificationsEnabled\(\)\) return;/
  );
  assert.match(
    source,
    /function sendClientPushAsync[\s\S]*if \(!fcmService\.statusNotificationsEnabled\(\)\)/
  );
  assert.match(
    source,
    /app\.post\("\/bot\/notificacoes\/teste"[\s\S]*if \(!fcmService\.manualNotificationsEnabled\(\)\)/
  );
});
