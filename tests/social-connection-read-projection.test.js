"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createPostgresConnectorStore, currentConnectionReadProjection, BLOCKING_CONNECTION_STATES } = require("../src/persistence/postgres/social-connector-store");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createConnectorContext } = require("../src/social/connectors/contract");
const { calendarConnectionFromDetails } = require("../src/social/calendar/connection");

function fixture() {
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "synthetic-v1" });
  const principal = auth.fromVerifiedJwt({ token_version: 2, iss: "ia4tube-api", aud: "ia4tube-client",
    whatsapp: "synthetic-owner", sub: "synthetic-owner", company_id: "synthetic-owner", jti: crypto.randomUUID() });
  const context = createConnectorContext({ principal, provider: "instagram", environment: "production",
    correlationId: crypto.randomUUID(), auditEventId: crypto.randomUUID() });
  const row = { company_id: context.companyId, id: crypto.randomUUID(), provider: "instagram", status: "active", revision: "7",
    created_at: "2026-10-27T12:00:00.000Z", connected_at: "2026-10-27T12:00:00.000Z",
    updated_at: "2026-10-27T12:00:00.000Z", disconnected_at: null, expires_at: null,
    external_account_id: crypto.randomUUID(), external_id: "17913756447515109", username: "synthetic_account",
    display_name: "Synthetic", account_type: "business", external_account_status: "active",
    active_credential_id: crypto.randomUUID(), credential_expires_at: "2026-10-27T12:01:00.000Z",
    granted_scopes: ["instagram_business_content_publish", "instagram_business_basic"], observed_at: "2026-10-27T12:00:30.000Z" };
  const projection = currentConnectionReadProjection({ companyId: context.companyId, provider: "instagram", statementTime: true });
  return { context, row, projection };
}

test("embedded fresh projection preserves the ordinary official connection shape and parameterized selection", async () => {
  const f = fixture(), observed = [];
  const client = { async query(text, values) {
    observed.push({ text, values }); return { rows: text.startsWith("SELECT connection.company_id") ? [f.row] : [] };
  }, release() {} };
  const store = createPostgresConnectorStore({ pool: { connect: async () => client } });
  const ordinary = await store.scope(f.context).getCurrentConnectionDetails();
  const query = observed.find(item => item.text.startsWith("SELECT connection.company_id"));
  assert.deepEqual(f.projection.map(JSON.parse(JSON.stringify(f.row))), ordinary);
  assert.equal(f.projection.text.replaceAll("statement_timestamp()", "CURRENT_TIMESTAMP"), query.text);
  assert.deepEqual(f.projection.values, [f.context.companyId, "instagram", BLOCKING_CONNECTION_STATES]);
  assert.deepEqual(query.values, f.projection.values);
  assert.equal(f.projection.text.includes("CURRENT_TIMESTAMP"), false);
  assert.doesNotMatch(f.projection.text, /FOR UPDATE|pg_advisory|ciphertext|auth_tag|nonce/);
  assert.ok(Object.isFrozen(f.projection) && Object.isFrozen(f.projection.values));
});

test("fresh observation expires the earlier of connection and credential while preserving exact account IDs", () => {
  const { row, projection } = fixture();
  assert.equal(projection.map(row).health, "healthy");
  assert.equal(projection.map(row).account.externalId, "17913756447515109");
  assert.equal(projection.map({ ...row, observed_at: row.credential_expires_at }).health, "reconnect_required");
  assert.equal(projection.map({ ...row, expires_at: row.observed_at }).health, "reconnect_required");
  assert.equal(projection.map({ ...row, active_credential_id: null }).health, "reconnect_required");
  assert.equal(projection.map({ ...row, external_account_status: "revoked" }).account, null);
  assert.equal(projection.map({ ...row, status: "revoked" }).state, "disconnected");
  assert.equal(projection.map(null), null);
});

test("projection refuses foreign tenant/provider and SQL-shaped configuration before exposing a mapped record", () => {
  const { row, projection } = fixture();
  for (const candidate of [{ ...row, company_id: crypto.randomUUID() }, { ...row, provider: "other" }]) {
    assert.throws(() => projection.map(candidate), { code: "resource_unavailable" });
  }
  for (const input of [
    { companyId: row.company_id, provider: "instagram", statementTime: "clock_timestamp()" },
    { companyId: "x'; SELECT 1", provider: "instagram" },
    { companyId: row.company_id, provider: "other" },
    { companyId: row.company_id, provider: "instagram", role: "owner" }
  ]) assert.throws(() => currentConnectionReadProjection(input), { code: "connector_contract_invalid" });
});

test("calendar connection policy still refuses missing scope, revoked credentials, bad health and nonprofessional accounts", () => {
  const { row, projection } = fixture(), details = projection.map(row);
  const allowed = calendarConnectionFromDetails(details);
  assert.deepEqual(allowed, { binding: { connectionId: row.id, externalId: row.external_id, connectionRevision: 7 },
    username: row.username, accountType: "business" });
  assert.equal(calendarConnectionFromDetails({ ...details, account: { ...details.account, accountType: "creator" } }).accountType, "creator");
  for (const candidate of [null, { ...details, state: "disconnected" }, { ...details, health: "reconnect_required" },
    { ...details, activeCredentialId: null }, { ...details, grantedScopes: ["instagram_business_basic"] },
    { ...details, account: { ...details.account, accountType: "personal" } }]) {
    assert.equal(calendarConnectionFromDetails(candidate), null);
  }
  assert.equal(JSON.stringify(allowed).includes(row.active_credential_id), false);
  allowed.binding.connectionRevision = 100;
  assert.equal(details.revision, 7);
});
