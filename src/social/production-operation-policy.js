"use strict";

const { UUID_PATTERN } = require("../persistence/postgres/validation");
const { postgresFail } = require("../persistence/postgres/errors");

const PRODUCTION_OPERATION_ALLOWLIST_ENV = "SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON";
const PRODUCTION_ORIGIN = "https://ia4tube-api.onrender.com";
const MAX_SUBJECTS = 32;

function invalidPolicy() {
  postgresFail("social_production_operation_allowlist_invalid",
    "Configuracao do escopo operacional de producao recusada.");
}

function loadProductionOperationPolicy(env) {
  const raw = env[PRODUCTION_OPERATION_ALLOWLIST_ENV];
  if (raw === undefined) return Object.freeze({ subjects: Object.freeze([]) });
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
  return Object.freeze({ subjects: Object.freeze(subjects) });
}

// Called only after requireConnectorContext authenticates the branded context.
// The pair never comes from a display label, client body or separately selected
// company/user allowlists; both members must match the same configured entry.
function canProductionOperation(config, context, gate) {
  return config?.environment === "production" && context.environment === "production" &&
    config.publicOrigin === PRODUCTION_ORIGIN && config.enabled === true &&
    config.instagramEnabled === true && config.appReview?.enabled !== true &&
    config.externalConnectionEnabled === true && config[gate] === true &&
    Array.isArray(config.productionOperations?.subjects) &&
    config.productionOperations.subjects.some(subject =>
      subject.companyId === context.companyId && subject.userId === context.userId);
}

module.exports = { PRODUCTION_OPERATION_ALLOWLIST_ENV, loadProductionOperationPolicy,
  canProductionOperation };
