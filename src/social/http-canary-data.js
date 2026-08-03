"use strict";

const crypto = require("node:crypto");
const { requireUuid } = require("../persistence/postgres/validation");

const SYNTHETIC_CANARY_PREFIX = "ia4tube_canary_http";

function createSyntheticHttpCanaryData(options = {}) {
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const companyA = requireUuid(options.companyA, "canary_company_a");
  const companyB = requireUuid(options.companyB, "canary_company_b");
  if (companyA === companyB) {
    const error = new Error("Canary companies must differ.");
    error.code = "social_http_canary_companies_must_differ";
    throw error;
  }

  const generated = [];
  for (let index = 0; index < 15; index += 1) {
    generated.push(requireUuid(randomUUID(), "canary_generated_id"));
  }
  if (new Set(generated).size !== generated.length) {
    const error = new Error("Canary identifiers must be unique.");
    error.code = "social_http_canary_identifier_collision";
    throw error;
  }

  const [
    runId,
    eventAId,
    eventAEventId,
    eventBId,
    eventBEventId,
    missingContextId,
    missingContextEventId,
    crossAToBId,
    crossAToBEventId,
    crossBToAId,
    crossBToAEventId,
    tamperedId,
    tamperedEventId,
    tamperedCompanyId,
    vaultCredentialId
  ] = generated;

  return Object.freeze({
    runId,
    companyA,
    companyB,
    eventA: Object.freeze({ id: eventAId, eventId: eventAEventId }),
    eventB: Object.freeze({ id: eventBId, eventId: eventBEventId }),
    missingContext: Object.freeze({
      companyId: companyA,
      id: missingContextId,
      eventId: missingContextEventId
    }),
    crossAToB: Object.freeze({
      companyId: companyB,
      id: crossAToBId,
      eventId: crossAToBEventId
    }),
    crossBToA: Object.freeze({
      companyId: companyA,
      id: crossBToAId,
      eventId: crossBToAEventId
    }),
    tampered: Object.freeze({
      companyId: companyA,
      id: tamperedId,
      eventId: tamperedEventId,
      scopeCompanyId: tamperedCompanyId
    }),
    vault: Object.freeze({
      credentialId: vaultCredentialId,
      subjectId: eventAId
    })
  });
}

module.exports = {
  SYNTHETIC_CANARY_PREFIX,
  createSyntheticHttpCanaryData
};
