"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createOperationalMediaPostgresFixture } = require("./helpers/operational-media-postgres-fixture");
const { initializeSocialSchema, seedSyntheticSocialAccount } = require("./helpers/operational-media-social-fixture");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createConnectorContext } = require("../src/social/connectors/contract");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
test("physical PostgreSQL uses real social migrations, restricted connector reads and survives actual database restart", async t => {
  const db = await createOperationalMediaPostgresFixture(t, { initializeSocialSchema });
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "synthetic-v1" });
  const principal = auth.fromVerifiedJwt({ token_version: 2, iss: "ia4tube-api", aud: "ia4tube-client",
    whatsapp: "synthetic-owner", sub: "synthetic-owner", company_id: "synthetic-owner", jti: crypto.randomUUID() });
  const context = createConnectorContext({ principal, provider: "instagram", environment: "production", correlationId: crypto.randomUUID(), auditEventId: crypto.randomUUID() });
  const seeded = await seedSyntheticSocialAccount(db, context);
  const store = () => createPostgresConnectorStore({ pool: db.tenantPool, role: "ia4tube_social_runtime", publicationBindingRequired: true });
  const initial = await store().scope(context).getCurrentConnectionDetails();
  assert.equal(initial.id, seeded.connectionId); assert.equal(initial.health, "healthy"); assert.equal(initial.state, "connected");
  assert.equal(initial.activeCredentialId, seeded.credentialId);
  const rls = await db.adminPool.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
    WHERE oid IN ('ia4tube_social.social_publications'::regclass,'ia4tube_calendar.owner_state'::regclass)`);
  assert.equal(rls.rowCount, 2); assert.ok(rls.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
  assert.equal((await db.tenantPool.query("SELECT count(*) FROM ia4tube_social.social_connections")).rows[0].count, "0");
  await db.restart();
  assert.equal((await store().scope(context).getCurrentConnectionDetails()).id, seeded.connectionId);
  t.diagnostic(`PERSISTENCE=PHYSICAL_POSTGRES_${db.databaseVersion}; REAL_SOCIAL_MIGRATIONS=0001_TO_0008; NETWORK=LOOPBACK_ONLY`);
});
