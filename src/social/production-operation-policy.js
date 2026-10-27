"use strict";

const { UUID_PATTERN } = require("../persistence/postgres/validation");
const { postgresFail } = require("../persistence/postgres/errors");

const PRODUCTION_OPERATION_ALLOWLIST_ENV = "SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON";
const PRODUCTION_CUSTOMER_ACCESS_ENV = "SOCIAL_PRODUCTION_CUSTOMER_ACCESS_ENABLED";
const PRODUCTION_ORIGIN = "https://ia4tube-api.onrender.com";
const MAX_SUBJECTS = 32;

function invalidPolicy() {
  postgresFail("social_production_operation_allowlist_invalid",
    "Configuracao do escopo operacional de producao recusada.");
}

function loadProductionOperationPolicy(env) {
  const customerAccessFlag = env[PRODUCTION_CUSTOMER_ACCESS_ENV];
  if ((customerAccessFlag !== undefined && customerAccessFlag !== "false" && customerAccessFlag !== "true") ||
      (customerAccessFlag === "true" && env.ENVIRONMENT !== "production")) {
    postgresFail("social_production_customer_access_invalid",
      "Configuracao de acesso de clientes em producao recusada.");
  }
  const customerAccessEnabled = customerAccessFlag === "true";
  const raw = env[PRODUCTION_OPERATION_ALLOWLIST_ENV];
  if (raw === undefined) return Object.freeze({ subjects: Object.freeze([]), customerAccessEnabled });
  // Only literal UUIDs and field names are needed. Escaped/duplicate field
  // spellings are refused instead of inheriting JSON's last-key-wins behavior.
  if (env.ENVIRONMENT !== "production" || typeof raw !== "string" ||
      raw.length > 8192 || raw.includes("\\")) invalidPolicy();
  let entries;
  try { entries = JSON.parse(raw); } catch { invalidPolicy(); }
  if (!Array.isArray(entries) || entries.length > MAX_SUBJECTS) invalidPolicy();
  const fieldCount = (raw.match(/"(?:companyId|userId)"\s*:/g) || []).length;
  if (fieldCount !== entries.length * 2) invalidPolicy();
  const seen = new Set();
  const subjects = entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "companyId") ||
        !Object.hasOwn(entry, "userId")) invalidPolicy();
    for (const name of ["companyId", "userId"]) {
      if (typeof entry[name] !== "string" || !UUID_PATTERN.test(entry[name]) ||
          entry[name] === "00000000-0000-0000-0000-000000000000") invalidPolicy();
    }
    const subject = Object.freeze({
      companyId: entry.companyId.toLowerCase(), userId: entry.userId.toLowerCase()
    });
    const key = `${subject.companyId}:${subject.userId}`;
    if (seen.has(key)) invalidPolicy();
    seen.add(key);
    return subject;
  });
  return Object.freeze({ subjects: Object.freeze(subjects), customerAccessEnabled });
}

// Both interactive requests and delegated calendar execution must carry a trusted
// context. Customer rollout changes eligibility, never tenant identity or gates.
function canProductionOperation(config, context, gate) {
  if (gate !== "externalConnectionEnabled" && gate !== "externalPublicationEnabled") return false;
  let trusted;
  try {
    // Lazy loading avoids the config/state-envelope/auth-adapter import cycle.
    trusted = require("./connectors/contract").requireConnectorContext(context,
      { provider: "instagram", environment: "production" });
  } catch { return false; }
  return config?.environment === "production" && trusted.environment === "production" &&
    config.publicOrigin === PRODUCTION_ORIGIN && config.enabled === true &&
    config.instagramEnabled === true && config.appReview?.enabled !== true &&
    config.externalConnectionEnabled === true && config[gate] === true &&
    Array.isArray(config.productionOperations?.subjects) &&
    (config.productionOperations.customerAccessEnabled === true ||
      config.productionOperations.subjects.some(subject =>
        subject.companyId === trusted.companyId && subject.userId === trusted.userId));
}

module.exports = { PRODUCTION_OPERATION_ALLOWLIST_ENV, PRODUCTION_CUSTOMER_ACCESS_ENV, loadProductionOperationPolicy,
  canProductionOperation };
