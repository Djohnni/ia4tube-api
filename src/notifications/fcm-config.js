"use strict";

const crypto = require("crypto");
const fs = require("fs");

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

function readServiceAccountSource({ env, source, fileSystem }) {
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

function credentialSourceState(env) {
  const directJsonConfigured = Boolean(
    configuredValue(env, "FIREBASE_SERVICE_ACCOUNT_JSON")
  );
  const credentialsFileConfigured = Boolean(
    configuredValue(env, "GOOGLE_APPLICATION_CREDENTIALS")
  );
  const tripletConfiguredFields = FIREBASE_TRIPLET_NAMES.filter((name) =>
    Boolean(configuredValue(env, name))
  );
  const tripletComplete =
    tripletConfiguredFields.length === FIREBASE_TRIPLET_NAMES.length;
  const sources = [
    directJsonConfigured ? "service_account_json" : "",
    credentialsFileConfigured ? "credentials_file" : "",
    tripletComplete ? "credential_triplet" : ""
  ].filter(Boolean);

  return {
    sources,
    tripletComplete,
    tripletPartial:
      tripletConfiguredFields.length > 0 && !tripletComplete
  };
}

function validateFcmRuntimeConfig(env = process.env, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const tokenRegistrationEnabled = explicitTrue(
    env.FCM_TOKEN_REGISTRATION_ENABLED
  );
  const artReadyEventEnabled = explicitTrue(
    env.FCM_ART_READY_EVENT_ENABLED
  );
  const deliveryEnabled = explicitTrue(env.FCM_DELIVERY_ENABLED);
  const automaticNotificationsEnabled = explicitTrue(
    env.FCM_AUTOMATIC_NOTIFICATIONS_ENABLED
  );
  const statusNotificationsEnabled =
    deliveryEnabled &&
    automaticNotificationsEnabled &&
    explicitTrue(env.FCM_STATUS_NOTIFICATIONS_ENABLED);
  const scheduledNotificationsEnabled =
    deliveryEnabled &&
    automaticNotificationsEnabled &&
    explicitTrue(env.FCM_SCHEDULED_NOTIFICATIONS_ENABLED);
  const manualNotificationsEnabled =
    deliveryEnabled &&
    explicitTrue(env.FCM_MANUAL_NOTIFICATIONS_ENABLED);

  const disabledConfig = {
    tokenRegistrationEnabled,
    artReadyEventEnabled,
    deliveryEnabled,
    automaticNotificationsEnabled,
    statusNotificationsEnabled,
    scheduledNotificationsEnabled,
    manualNotificationsEnabled,
    credentialConfigured: false,
    credentialSourceCount: 0,
    expectedProjectConfigured: false,
    projectMatchesExpected: false,
    serviceAccount: null
  };

  // A entrega fechada nao le arquivo, nao analisa JSON, nao valida chave
  // privada e nao impede a inicializacao do backend.
  if (!deliveryEnabled) {
    return Object.freeze(disabledConfig);
  }

  const credentialState = credentialSourceState(env);
  if (credentialState.tripletPartial) {
    fail("fcm_credentials_triplet_partial");
  }
  if (credentialState.sources.length > 1) {
    fail("fcm_multiple_credential_sources");
  }
  if (credentialState.sources.length !== 1) {
    fail("fcm_credentials_missing");
  }

  const expectedProjectId = configuredValue(
    env,
    "FIREBASE_EXPECTED_PROJECT_ID"
  );
  if (!expectedProjectId) {
    fail("fcm_expected_project_missing");
  }

  const serviceAccount = validateServiceAccount(
    readServiceAccountSource({
      env,
      source: credentialState.sources[0],
      fileSystem
    })
  );
  if (serviceAccount.project_id !== expectedProjectId) {
    fail("fcm_project_mismatch");
  }

  return Object.freeze({
    ...disabledConfig,
    credentialSourceCount: credentialState.sources.length,
    credentialConfigured: true,
    expectedProjectConfigured: true,
    projectMatchesExpected: true,
    serviceAccount
  });
}

function safeRuntimeSummary(config) {
  return {
    code: "fcm_safety_ready",
    token_registration_enabled: Boolean(config?.tokenRegistrationEnabled),
    art_ready_event_enabled: Boolean(config?.artReadyEventEnabled),
    delivery_enabled: Boolean(config?.deliveryEnabled),
    automatic_notifications_enabled: Boolean(
      config?.automaticNotificationsEnabled
    ),
    status_notifications_enabled: Boolean(
      config?.statusNotificationsEnabled
    ),
    scheduled_notifications_enabled: Boolean(
      config?.scheduledNotificationsEnabled
    ),
    manual_notifications_enabled: Boolean(
      config?.manualNotificationsEnabled
    ),
    credential_configured: Boolean(config?.credentialConfigured),
    credential_source_count_valid: Number(config?.credentialSourceCount || 0) <= 1,
    expected_project_configured: Boolean(config?.expectedProjectConfigured),
    project_matches_expected: Boolean(config?.projectMatchesExpected)
  };
}

module.exports = {
  FcmConfigurationError,
  explicitTrue,
  safeRuntimeSummary,
  validateFcmRuntimeConfig
};
