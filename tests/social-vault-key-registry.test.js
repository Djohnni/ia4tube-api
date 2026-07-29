"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CREDENTIAL_KEY_FOREIGN_KEY,
  VAULT_KEY_REGISTRY,
  createVaultKeyRegistryAdmin
} = require("../src/persistence/postgres/vault-key-registry-admin");
const {
  deriveVaultKeyVersion
} = require("../src/social/vault-key-version");

const root = path.resolve(__dirname, "..");
const immutableMigrationHashes = Object.freeze({
  "0001_social_multitenant_foundation.up.sql":
    "ecab91eb1b915378b6d98edfa66c929c3558054349fbda8b25dbf274191a21bb",
  "0002_social_connections_and_vault.up.sql":
    "72b05e7de90cd2d7742b5622bc92f9e9d78168317b9b7d547a5adb1b918d722d",
  "0003_global_vault_key_registry.up.sql":
    "28e63269e5d31ebd05b49f24194be706d3e65eed3fa7f6b39f9051cfc9b96db7"
});
const V1 = deriveVaultKeyVersion(1, Buffer.alloc(32, 1));
const V2 = deriveVaultKeyVersion(2, Buffer.alloc(32, 2));
const V3 = deriveVaultKeyVersion(3, Buffer.alloc(32, 3));
const V9 = deriveVaultKeyVersion(9, Buffer.alloc(32, 9));

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sha256(relativePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, relativePath)))
    .digest("hex");
}

function fakePool(handler) {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes("pg_advisory_unlock")) {
        return { rowCount: 1, rows: [{ unlocked: true }] };
      }
      if (text.includes("pg_advisory_lock")) {
        return { rowCount: 1, rows: [{}] };
      }
      return handler(text, values);
    },
    release(error) {
      client.released = true;
      client.releaseError = error;
    },
    released: false
  };
  return {
    client,
    queries,
    pool: {
      async connect() {
        return client;
      }
    }
  };
}

test("migration 0003 keeps its approved bytes and adds a global RESTRICT registry", () => {
  for (const [file, expected] of Object.entries(
    immutableMigrationHashes
  )) {
    assert.equal(sha256(`db/migrations/${file}`), expected);
  }

  const sql = read(
    "db/migrations/0003_global_vault_key_registry.up.sql"
  );
  const manifest = JSON.parse(
    read("db/migrations/checksums.json")
  ).migrations;
  assert.deepEqual(
    manifest.map((migration) => migration.version),
    [
      "0001_social_multitenant_foundation",
      "0002_social_connections_and_vault",
      "0003_global_vault_key_registry"
    ]
  );
  assert.equal(
    manifest[2].sha256,
    sha256("db/migrations/0003_global_vault_key_registry.up.sql")
  );
  assert.match(
    sql,
    /CREATE SCHEMA ia4tube_social_admin\s+AUTHORIZATION ia4tube_social_owner/
  );
  assert.match(
    sql,
    /CREATE TABLE ia4tube_social_admin\.vault_key_versions/
  );
  assert.match(
    sql,
    /REVOKE ALL ON SCHEMA ia4tube_social_admin\s+FROM ia4tube_social_runtime/
  );
  assert.match(
    sql,
    /REVOKE ALL ON ia4tube_social_admin\.vault_key_versions\s+FROM ia4tube_social_runtime/
  );
  assert.match(
    sql,
    /FOREIGN KEY \(key_version\)[\s\S]*ON UPDATE RESTRICT[\s\S]*ON DELETE RESTRICT/
  );
  assert.equal(/\bBYPASSRLS\b/i.test(sql), false);

  const seed = sql.indexOf(
    "INSERT INTO ia4tube_social_admin.vault_key_versions"
  );
  const foreignKey = sql.indexOf(
    "ADD CONSTRAINT social_encrypted_credentials_key_version_fk"
  );
  assert.ok(seed >= 0);
  assert.ok(foreignKey > seed);
});

test("admin registry registers and retires only through the owner role", async () => {
  const harness = fakePool((text) => {
    if (text.startsWith(`INSERT INTO ${VAULT_KEY_REGISTRY}`)) {
      return { rowCount: 1, rows: [{ key_version: V2 }] };
    }
    if (text.startsWith(`DELETE FROM ${VAULT_KEY_REGISTRY}`)) {
      return { rowCount: 1, rows: [{ key_version: V1 }] };
    }
    return { rowCount: 0, rows: [] };
  });
  const admin = createVaultKeyRegistryAdmin({ pool: harness.pool });

  assert.deepEqual(await admin.register({ keyVersion: V2 }), {
    keyVersion: V2,
    registered: true
  });
  assert.deepEqual(await admin.retire({ keyVersion: V1 }), {
    keyVersion: V1,
    retired: true
  });

  const texts = harness.queries.map((query) => query.text);
  assert.equal(
    texts.filter(
      (text) => text === 'SET LOCAL ROLE "ia4tube_social_owner"'
    ).length,
    2
  );
  assert.equal(
    texts.some((text) => text.includes("ia4tube.company_id")),
    false
  );
  assert.equal(
    texts.some((text) =>
      text.includes("social_encrypted_credentials WHERE")
    ),
    false
  );
  assert.equal(harness.client.released, true);
});

for (const postgresErrorCode of ["23001", "23503"]) {
  test(`physical foreign key refusal ${postgresErrorCode} becomes a closed administrative error`, async () => {
    const harness = fakePool((text) => {
      if (text.startsWith(`DELETE FROM ${VAULT_KEY_REGISTRY}`)) {
        const error = new Error("synthetic foreign key refusal");
        error.code = postgresErrorCode;
        error.constraint = CREDENTIAL_KEY_FOREIGN_KEY;
        throw error;
      }
      return { rowCount: 0, rows: [] };
    });
    const admin = createVaultKeyRegistryAdmin({ pool: harness.pool });

    await assert.rejects(
      admin.retire({ keyVersion: V1 }),
      (error) =>
        error?.code === "vault_key_version_in_use" &&
        error?.cause === undefined &&
        !String(error?.message || "").includes(V1)
    );
    assert.equal(
      harness.queries.some((query) => query.text === "ROLLBACK"),
      true
    );
    assert.equal(harness.client.released, true);
  });
}

test("unknown versions and unauthorized owner role fail closed", async () => {
  const missing = fakePool((text) => {
    if (text.startsWith(`DELETE FROM ${VAULT_KEY_REGISTRY}`)) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  await assert.rejects(
    createVaultKeyRegistryAdmin({ pool: missing.pool }).retire({
      keyVersion: V9
    }),
    { code: "vault_key_version_not_registered" }
  );
  assert.equal(
    missing.queries.some((query) => query.text === "ROLLBACK"),
    true
  );

  assert.throws(
    () =>
      createVaultKeyRegistryAdmin({
        pool: missing.pool,
        ownerRole: "unexpected_owner"
      }),
    { code: "vault_key_admin_role_must_be_canonical" }
  );
});

test("runtime-like principal cannot reach the registry without SET owner", async () => {
  const harness = fakePool((text) => {
    if (text === 'SET LOCAL ROLE "ia4tube_social_owner"') {
      const error = new Error("synthetic permission denied");
      error.code = "42501";
      throw error;
    }
    return { rowCount: 0, rows: [] };
  });
  const admin = createVaultKeyRegistryAdmin({ pool: harness.pool });
  await assert.rejects(
    admin.register({ keyVersion: V3 }),
    (error) => error?.code === "42501"
  );
  assert.equal(
    harness.queries.some((query) =>
      query.text.startsWith(`INSERT INTO ${VAULT_KEY_REGISTRY}`)
    ),
    false
  );
  assert.equal(
    harness.queries.some((query) => query.text === "ROLLBACK"),
    true
  );
});
