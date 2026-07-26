"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  STAGING_FIREBASE_PROJECT_ID,
  STAGING_PUBLIC_API_BASE_URL,
  validateFcmRuntimeConfig
} = require("../src/notifications/fcm-config");

const FCM_ENV_NAMES = [
  "FCM_DELIVERY_ENABLED",
  "FCM_AUTOMATIC_NOTIFICATIONS_ENABLED",
  "FCM_MOCK",
  "FIREBASE_EXPECTED_PROJECT_ID",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "PUBLIC_API_BASE_URL"
];

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem"
  },
  publicKeyEncoding: {
    type: "spki",
    format: "pem"
  }
});

function syntheticServiceAccount(projectId = STAGING_FIREBASE_PROJECT_ID) {
  return {
    project_id: projectId,
    client_email: "synthetic-staging@ia4tube-staging-checkpoint-a.iam.gserviceaccount.com",
    private_key: privateKey
  };
}

function stagingEnv(overrides = {}) {
  return {
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    FIREBASE_EXPECTED_PROJECT_ID: STAGING_FIREBASE_PROJECT_ID,
    PUBLIC_API_BASE_URL: STAGING_PUBLIC_API_BASE_URL,
    ...overrides
  };
}

function assertConfigError(code, env, options) {
  assert.throws(
    () => validateFcmRuntimeConfig(env, options),
    (error) => error?.code === code
  );
}

function withProcessEnv(env, callback) {
  const previous = Object.fromEntries(
    FCM_ENV_NAMES.map((name) => [name, process.env[name]])
  );

  for (const name of FCM_ENV_NAMES) {
    delete process.env[name];
  }
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
      for (const name of FCM_ENV_NAMES) {
        if (previous[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous[name];
        }
      }
    });
}

async function run() {
  const correctAccount = syntheticServiceAccount();
  const correctAccountJson = JSON.stringify(correctAccount);

  const initialization = validateFcmRuntimeConfig(stagingEnv({
    FIREBASE_SERVICE_ACCOUNT_JSON: correctAccountJson
  }));
  assert.strictEqual(initialization.deliveryEnabled, false);
  assert.strictEqual(initialization.credentialConfigured, true);
  assert.strictEqual(initialization.projectMatchesExpected, true);
  assert.strictEqual(initialization.automaticNotificationsEnabled, false);

  const fileInitialization = validateFcmRuntimeConfig(
    stagingEnv({
      GOOGLE_APPLICATION_CREDENTIALS: "synthetic-service-account.json"
    }),
    {
      fileSystem: {
        existsSync: () => true,
        readFileSync: () => correctAccountJson
      }
    }
  );
  assert.strictEqual(fileInitialization.credentialConfigured, true);
  assert.strictEqual(fileInitialization.credentialSourceCount, 1);

  const tripletInitialization = validateFcmRuntimeConfig(stagingEnv({
    FIREBASE_PROJECT_ID: correctAccount.project_id,
    FIREBASE_CLIENT_EMAIL: correctAccount.client_email,
    FIREBASE_PRIVATE_KEY: correctAccount.private_key
  }));
  assert.strictEqual(tripletInitialization.credentialConfigured, true);
  assert.strictEqual(tripletInitialization.credentialSourceCount, 1);

  const nonExplicitDelivery = validateFcmRuntimeConfig(stagingEnv({
    FCM_DELIVERY_ENABLED: "TRUE",
    FIREBASE_SERVICE_ACCOUNT_JSON: correctAccountJson
  }));
  assert.strictEqual(nonExplicitDelivery.deliveryEnabled, false);

  assertConfigError(
    "fcm_project_mismatch",
    stagingEnv({
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(
        syntheticServiceAccount("synthetic-other-project")
      )
    })
  );

  assertConfigError(
    "fcm_credentials_invalid",
    stagingEnv({
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: correctAccount.client_email,
        private_key: correctAccount.private_key
      })
    })
  );

  assertConfigError(
    "fcm_multiple_credential_sources",
    stagingEnv({
      FIREBASE_SERVICE_ACCOUNT_JSON: correctAccountJson,
      GOOGLE_APPLICATION_CREDENTIALS: "synthetic-service-account.json"
    })
  );

  assertConfigError(
    "fcm_credentials_triplet_partial",
    stagingEnv({
      FIREBASE_PROJECT_ID: STAGING_FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: correctAccount.client_email
    })
  );

  assertConfigError(
    "fcm_expected_project_missing",
    {
      FCM_DELIVERY_ENABLED: "false",
      FIREBASE_SERVICE_ACCOUNT_JSON: correctAccountJson,
      PUBLIC_API_BASE_URL: STAGING_PUBLIC_API_BASE_URL
    }
  );

  assertConfigError(
    "fcm_expected_project_forbidden",
    stagingEnv({
      FIREBASE_EXPECTED_PROJECT_ID: "synthetic-production-project"
    })
  );

  assertConfigError(
    "fcm_production_url_forbidden",
    stagingEnv({
      PUBLIC_API_BASE_URL: "https://ia4tube-api.onrender.com"
    })
  );

  assertConfigError(
    "fcm_staging_url_invalid",
    {
      FCM_DELIVERY_ENABLED: "false",
      FIREBASE_EXPECTED_PROJECT_ID: STAGING_FIREBASE_PROJECT_ID
    }
  );

  assertConfigError(
    "fcm_automatic_notifications_forbidden_in_staging",
    stagingEnv({
      FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "true"
    })
  );

  assertConfigError(
    "fcm_credentials_missing",
    stagingEnv({
      FCM_DELIVERY_ENABLED: "true"
    })
  );

  let externalRequests = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => {
    externalRequests += 1;
    throw new Error("external_request_forbidden");
  };

  const syntheticToken = "synthetic-fcm-token-never-log";
  const syntheticJwt = "synthetic-jwt-never-log";
  const capturedLogs = [];
  const previousLog = console.log;
  const previousError = console.error;
  console.log = (...args) => capturedLogs.push(args);
  console.error = (...args) => capturedLogs.push(args);

  try {
    await withProcessEnv(
      stagingEnv({
        FCM_DELIVERY_ENABLED: "false",
        FCM_MOCK: "true",
        FIREBASE_SERVICE_ACCOUNT_JSON: correctAccountJson
      }),
      async (fcmService) => {
        const result = await fcmService.sendToClient(
          {
            notificacoes: {
              fcm_tokens: [{ token: syntheticToken, ativo: true }]
            }
          },
          {
            title: "Synthetic title",
            body: syntheticJwt
          }
        );

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, "fcm_delivery_disabled");
        assert.strictEqual(fcmService.automaticNotificationsEnabled(), false);
        assert.deepStrictEqual(
          Object.values(fcmService.runtimeConfigSummary()).filter(
            (value) => typeof value !== "boolean" && typeof value !== "string"
          ),
          []
        );
      }
    );
  } finally {
    global.fetch = previousFetch;
    console.log = previousLog;
    console.error = previousError;
  }

  assert.strictEqual(externalRequests, 0);
  const serializedLogs = JSON.stringify(capturedLogs);
  assert.strictEqual(serializedLogs.includes(syntheticToken), false);
  assert.strictEqual(serializedLogs.includes(syntheticJwt), false);
  assert.strictEqual(serializedLogs.includes(correctAccount.client_email), false);
  assert.strictEqual(serializedLogs.includes(correctAccount.private_key), false);

  const serverSource = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8"
  );
  assert.match(
    serverSource,
    /if \(fcmService\.automaticNotificationsEnabled\(\)\) \{[\s\S]*setTimeout\(runMonthlyPlanningNotifications/
  );
  assert.match(
    serverSource,
    /async function runMonthlyPlanningNotifications\(\) \{\s*if \(!fcmService\.automaticNotificationsEnabled\(\)\) return;/
  );
  assert.match(
    serverSource,
    /async function runFreeArtCampaignNotifications\(\) \{\s*if \(!fcmService\.automaticNotificationsEnabled\(\)\) return;/
  );

  console.log("fcm-safety.test.js ok");
}

run().catch((error) => {
  console.error({
    code: error?.code || "fcm_safety_test_failed",
    message: "FCM safety test failed."
  });
  process.exit(1);
});
