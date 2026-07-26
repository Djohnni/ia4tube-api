"use strict";

const crypto = require("crypto");
const fs = require("fs");

const STAGING_FIREBASE_PROJECT_ID = "ia4tube-staging-checkpoint-a";
const STAGING_PUBLIC_API_BASE_URL = "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const PRODUCTION_PUBLIC_API_BASE_URL = "https://ia4tube-api.onrender.com";
const FIREBASE_TRIPLET_NAMES = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY"
];

class FcmConfigurationError extends Error {
  constructor(code) {
    super("Configuracao FCM recusada por uma regra de seguranca.");
    this.name = "FcmConfigurationError";
    this.code = code;
  }
}

function fail(code) {
  throw new FcmConfigurationError(code);
}

function configuredValue(env, name) {
  return String(env?.[name] || "").trim();
}

function explicitTrue(value) {
  return String(value || "").trim() === "true";
}

function normalizePrivateKey(value = "") {
  return String(value || "").replace(/\\n/g, "\n");
}

function validatePrivateKey(value) {
  try {
    crypto.createPrivateKey(normalizePrivateKey(value));
  } catch {
    fail("fcm_credentials_invalid");
  }
}

function validateServiceAccount(serviceAccount) {
  if (!serviceAccount || typeof serviceAccount !== "object" || Array.isArray(serviceAccount)) {
    fail("fcm_credentials_invalid");
  }

  const projectId = String(serviceAccount.project_id || "").trim();
  const clientEmail = String(serviceAccount.client_email || "").trim();
  const privateKey = normalizePrivateKey(serviceAccount.private_key || "");

  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
    !/^[^@\s]+@[^@\s]+$/.test(clientEmail) ||
    !privateKey
  ) {
    fail("fcm_credentials_invalid");
  }

  validatePrivateKey(privateKey);

  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey
  };
}

function readServiceAccountSource({
  env,
  source,
  fileSystem
}) {
  if (source === "service_account_json") {
    try {
      return JSON.parse(configuredValue(env, "FIREBASE_SERVICE_ACCOUNT_JSON"));
    } catch {
      fail("fcm_credentials_json_invalid");
    }
  }

  if (source === "credentials_file") {
    const credentialsPath = configuredValue(env, "GOOGLE_APPLICATION_CREDENTIALS");
    try {
      if (!fileSystem.existsSync(credentialsPath)) {
        fail("fcm_credentials_file_unavailable");
      }
      return JSON.parse(fileSystem.readFileSync(credentialsPath, "utf8"));
    } catch (error) {
      if (error instanceof FcmConfigurationError) throw error;
      fail("fcm_credentials_file_invalid");
    }
  }

  if (source === "credential_triplet") {
    return {
      project_id: configuredValue(env, "FIREBASE_PROJECT_ID"),
      client_email: configuredValue(env, "FIREBASE_CLIENT_EMAIL"),
      private_key: configuredValue(env, "FIREBASE_PRIVATE_KEY")
    };
  }

  return null;
}

function validateStagingPublicUrl(env, configurationRequested) {
  const publicApiBaseUrl = configuredValue(env, "PUBLIC_API_BASE_URL");
  if (!configurationRequested && !publicApiBaseUrl) return;

  if (publicApiBaseUrl === PRODUCTION_PUBLIC_API_BASE_URL) {
    fail("fcm_production_url_forbidden");
  }

  if (!configurationRequested) return;

  let parsed;
  try {
    parsed = new URL(publicApiBaseUrl);
  } catch {
    fail("fcm_staging_url_invalid");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.origin !== STAGING_PUBLIC_API_BASE_URL
  ) {
    fail("fcm_staging_url_invalid");
  }
}

function validateFcmRuntimeConfig(env = process.env, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const deliveryEnabled = explicitTrue(env.FCM_DELIVERY_ENABLED);
  const automaticNotificationsRequested = explicitTrue(
    env.FCM_AUTOMATIC_NOTIFICATIONS_ENABLED
  );
  const expectedProjectId = configuredValue(env, "FIREBASE_EXPECTED_PROJECT_ID");

  const directJsonConfigured = Boolean(
    configuredValue(env, "FIREBASE_SERVICE_ACCOUNT_JSON")
  );
  const credentialsFileConfigured = Boolean(
    configuredValue(env, "GOOGLE_APPLICATION_CREDENTIALS")
  );
  const tripletConfiguredFields = FIREBASE_TRIPLET_NAMES.filter((name) =>
    Boolean(configuredValue(env, name))
  );

  if (
    tripletConfiguredFields.length > 0 &&
    tripletConfiguredFields.length < FIREBASE_TRIPLET_NAMES.length
  ) {
    fail("fcm_credentials_triplet_partial");
  }

  const sources = [
    directJsonConfigured ? "service_account_json" : "",
    credentialsFileConfigured ? "credentials_file" : "",
    tripletConfiguredFields.length === FIREBASE_TRIPLET_NAMES.length
      ? "credential_triplet"
      : ""
  ].filter(Boolean);

  if (sources.length > 1) {
    fail("fcm_multiple_credential_sources");
  }

  const configurationRequested = Boolean(
    deliveryEnabled ||
    automaticNotificationsRequested ||
    expectedProjectId ||
    sources.length
  );

  validateStagingPublicUrl(env, configurationRequested);

  if (configurationRequested && expectedProjectId !== STAGING_FIREBASE_PROJECT_ID) {
    fail(
      expectedProjectId
        ? "fcm_expected_project_forbidden"
        : "fcm_expected_project_missing"
    );
  }

  if (automaticNotificationsRequested) {
    fail("fcm_automatic_notifications_forbidden_in_staging");
  }

  let serviceAccount = null;
  if (sources.length === 1) {
    serviceAccount = validateServiceAccount(
      readServiceAccountSource({
        env,
        source: sources[0],
        fileSystem
      })
    );

    if (serviceAccount.project_id !== expectedProjectId) {
      fail("fcm_project_mismatch");
    }
  }

  if (deliveryEnabled && !serviceAccount) {
    fail("fcm_credentials_missing");
  }

  return Object.freeze({
    deliveryEnabled,
    automaticNotificationsEnabled: false,
    credentialConfigured: Boolean(serviceAccount),
    credentialSourceCount: sources.length,
    expectedProjectConfigured: Boolean(expectedProjectId),
    projectMatchesExpected: Boolean(
      serviceAccount && serviceAccount.project_id === expectedProjectId
    ),
    serviceAccount
  });
}

function safeRuntimeSummary(config) {
  return {
    code: "fcm_safety_ready",
    delivery_enabled: Boolean(config?.deliveryEnabled),
    automatic_notifications_enabled: Boolean(
      config?.automaticNotificationsEnabled
    ),
    credential_configured: Boolean(config?.credentialConfigured),
    credential_source_count_valid: Number(config?.credentialSourceCount || 0) <= 1,
    expected_project_configured: Boolean(config?.expectedProjectConfigured),
    project_matches_expected: Boolean(config?.projectMatchesExpected)
  };
}

module.exports = {
  FcmConfigurationError,
  PRODUCTION_PUBLIC_API_BASE_URL,
  STAGING_FIREBASE_PROJECT_ID,
  STAGING_PUBLIC_API_BASE_URL,
  explicitTrue,
  safeRuntimeSummary,
  validateFcmRuntimeConfig
};
