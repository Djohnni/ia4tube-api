"use strict";

const { connectorFail } = require("../../social/connectors/errors");

// Every account/credential writer and publication stage uses this SAME lock.
// Transactions are short: callers must commit before provider network I/O.
async function lockSocialConnection(client, companyId, provider) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`${companyId}:${provider}`]
  );
}

async function assertNoPendingPublications(client, companyId, provider) {
  await lockSocialConnection(client, companyId, provider);
  const pending = await client.query([
    "SELECT id FROM ia4tube_social.social_publications",
    "WHERE company_id=$1 AND provider=$2",
    " AND state IN ('ready','publishing','provider_confirming') LIMIT 1"
  ].join("\n"), [companyId, provider]);
  // Never infer cancellation from age. An uncertain provider request remains
  // reserved until explicit, evidence-backed reconciliation resolves it.
  if (pending.rows?.length) connectorFail("state_transition_invalid");
}

module.exports = { lockSocialConnection, assertNoPendingPublications };
