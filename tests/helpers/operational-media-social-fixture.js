"use strict";
// Synthetic, loopback-only extension of the physical PostgreSQL fixture. The
// actual social SQL migrations are used unchanged, not a SQL-emulating pool.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
async function initializeSocialSchema({ adminPool }) {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN; SET LOCAL ROLE ia4tube_social_owner");
    // Ledger structure matches migrations.ensureLedger. This fixture does not
    // test provisioning/production migration authority and cannot reach it.
    await client.query(`CREATE SCHEMA ia4tube_migrations AUTHORIZATION ia4tube_social_owner;
      REVOKE ALL ON SCHEMA ia4tube_migrations FROM PUBLIC;
      CREATE TABLE ia4tube_migrations.schema_migrations(
        version TEXT PRIMARY KEY, checksum_sha256 CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, execution_ms BIGINT NOT NULL,
        CONSTRAINT ia4tube_schema_migrations_version_not_blank CHECK(length(btrim(version))>0),
        CONSTRAINT ia4tube_schema_migrations_checksum_format CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT ia4tube_schema_migrations_duration_nonnegative CHECK(execution_ms>=0));
      REVOKE ALL ON ia4tube_migrations.schema_migrations FROM PUBLIC;`);
    const directory = path.resolve(__dirname, "../../db/migrations");
    const files = (await fs.readdir(directory)).filter(name => /^000[1-8]_.*\.up\.sql$/.test(name)).sort();
    assert.equal(files.length, 8);
    for (const name of files) {
      const sql = await fs.readFile(path.join(directory, name), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO ia4tube_migrations.schema_migrations(version,checksum_sha256,execution_ms) VALUES($1,$2,0)",
        [name.replace(/\.up\.sql$/, ""), crypto.createHash("sha256").update(sql).digest("hex")]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function seedSyntheticSocialAccount(db, context, { externalId = "123456789012345", username = "synthetic_local_owner" } = {}) {
  const connectionId = crypto.randomUUID(), credentialId = crypto.randomUUID(), accountId = crypto.randomUUID();
  // Provisioning exclusively into the fresh synthetic database; runtime reads
  // and all publication writes below use restricted tenantPool with forced RLS.
  const client = await db.adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO ia4tube_social.companies(id,name,identity_derivation_version)
      VALUES($1,'Synthetic iA4tube local proof','synthetic-v1') ON CONFLICT(id) DO NOTHING`, [context.companyId]);
    await client.query(`INSERT INTO ia4tube_social.users(company_id,id,login_key_digest) VALUES($1,$2,$3)`,
      [context.companyId, context.userId, crypto.createHash("sha256").update(context.userId).digest("hex")]);
    await client.query(`INSERT INTO ia4tube_social.company_memberships(company_id,user_id,role) VALUES($1,$2,'owner')`,
      [context.companyId, context.userId]);
    await client.query(`INSERT INTO ia4tube_social.social_connections(company_id,id,provider,status,connected_at,created_by_user_id,revision)
      VALUES($1,$2,'instagram','connected',CURRENT_TIMESTAMP,$3,1)`, [context.companyId, connectionId, context.userId]);
    await client.query(`INSERT INTO ia4tube_social.social_external_accounts(company_id,id,connection_id,provider,external_id,username,account_type)
      VALUES($1,$2,$3,'instagram',$4,$5,'business')`, [context.companyId, accountId, connectionId, externalId, username]);
    await client.query(`INSERT INTO ia4tube_social.social_connection_scopes(company_id,connection_id,scope)
      VALUES($1,$2,'instagram_business_basic'),($1,$2,'instagram_business_content_publish')`, [context.companyId, connectionId]);
    await client.query(`INSERT INTO ia4tube_social_admin.vault_key_versions(key_version) VALUES('synthetic-v1') ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO ia4tube_social.social_encrypted_credentials(company_id,id,provider,connection_id,credential_type,
      ciphertext,nonce,auth_tag,key_version,aad_version)
      VALUES($1,$2,'instagram',$3,'instagram_user_access_token',$4,$5,$6,'synthetic-v1',1)`,
      [context.companyId, credentialId, connectionId, Buffer.from("synthetic-not-real-ciphertext"), crypto.randomBytes(12), crypto.randomBytes(16)]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { connectionId, credentialId, accountId, binding: { connectionId, externalId, connectionRevision: 1 } };
}
const syntheticCredentials = Object.freeze({ async withDecryptedCredential(_input, action) {
  const value = Buffer.from("synthetic-local-transport-only");
  try { return await action(value); } finally { value.fill(0); }
} });
module.exports = { initializeSocialSchema, seedSyntheticSocialAccount, syntheticCredentials };
