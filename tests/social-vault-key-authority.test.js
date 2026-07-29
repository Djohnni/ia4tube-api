"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateContractRows } = require(
  "../src/persistence/postgres/runtime-validation"
);
const {
  CREDENTIAL_KEY_FOREIGN_KEY,
  VAULT_ROTATION_LOCK_ID,
  activeMarker,
  createVaultKeyRegistryAdmin,
  parseRegistryRows,
  retirementMarker,
  versionDigest
} = require("../src/persistence/postgres/vault-key-registry-admin");
const {
  createSocialVault,
  parseVaultKeyring
} = require("../src/social/vault");
const {
  deriveVaultKeyVersion
} = require("../src/social/vault-key-version");

const root = path.resolve(__dirname, "..");
const immutableHashes = Object.freeze({
  "0001_social_multitenant_foundation.up.sql":
    "ecab91eb1b915378b6d98edfa66c929c3558054349fbda8b25dbf274191a21bb",
  "0002_social_connections_and_vault.up.sql":
    "72b05e7de90cd2d7742b5622bc92f9e9d78168317b9b7d547a5adb1b918d722d",
  "0003_global_vault_key_registry.up.sql":
    "28e63269e5d31ebd05b49f24194be706d3e65eed3fa7f6b39f9051cfc9b96db7",
  "checksums.json":
    "fa7b4a377709e50b3a8b69ad192afe21966beaf7a52b4b22395527a9ed0cd40d"
});
const RUNTIME_2A_VALIDATOR_SHA256 =
  "38b4a832050ade38becd28330172cba9cc39dd8a978ceb3aff953b0c44e01b9b";
const keyV1 = Buffer.alloc(32, 1);
const keyV2 = Buffer.alloc(32, 2);
const keyV3 = Buffer.alloc(32, 3);
const V1 = deriveVaultKeyVersion(1, keyV1);
const V2 = deriveVaultKeyVersion(2, keyV2);
const V3 = deriveVaultKeyVersion(3, keyV3);
const V1_DIFFERENT_MATERIAL = deriveVaultKeyVersion(
  1,
  Buffer.alloc(32, 4)
);

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sha256(relativePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, relativePath)))
    .digest("hex");
}

function authorityPool() {
  const state = {
    credentialReferences: new Set(),
    events: [],
    registry: new Map(),
    releases: []
  };
  let timestamp = 0;
  function registerRow(keyVersion) {
    timestamp += 1;
    const registeredAt = new Date(
      `2026-07-29T12:00:${String(timestamp).padStart(2, "0")}.000Z`
    );
    state.registry.set(keyVersion, registeredAt);
    return registeredAt;
  }

  const client = {
    async query(text, values = []) {
      state.events.push({ text, values });
      if (text.includes("pg_advisory_unlock")) {
        return { rowCount: 1, rows: [{ unlocked: true }] };
      }
      if (text.includes("pg_advisory_lock")) {
        assert.equal(values[0], VAULT_ROTATION_LOCK_ID);
        return { rowCount: 1, rows: [{}] };
      }
      if (
        ["BEGIN", "COMMIT", "ROLLBACK"].includes(text) ||
        text === 'SET LOCAL ROLE "ia4tube_social_owner"'
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (
        text.startsWith("SELECT key_version, registered_at") &&
        text.includes(
          "FROM ia4tube_social_admin.vault_key_versions"
        )
      ) {
        const rows = [...state.registry.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key_version, registered_at]) => ({
            key_version,
            registered_at
          }));
        return { rowCount: rows.length, rows };
      }
      if (
        text.startsWith(
          "INSERT INTO ia4tube_social_admin.vault_key_versions"
        )
      ) {
        const keyVersion = values[0];
        if (state.registry.has(keyVersion)) {
          if (text.includes("ON CONFLICT")) {
            return { rowCount: 0, rows: [] };
          }
          const conflict = new Error("synthetic duplicate marker");
          conflict.code = "23505";
          throw conflict;
        }
        const registeredAt = registerRow(keyVersion);
        return {
          rowCount: 1,
          rows: [
            {
              key_version: keyVersion,
              registered_at: registeredAt
            }
          ]
        };
      }
      if (
        text.startsWith(
          "DELETE FROM ia4tube_social_admin.vault_key_versions"
        )
      ) {
        const keyVersion = values[0];
        if (state.credentialReferences.has(keyVersion)) {
          const error = new Error("synthetic credential reference");
          error.code = "23503";
          error.constraint = CREDENTIAL_KEY_FOREIGN_KEY;
          throw error;
        }
        if (!state.registry.delete(keyVersion)) {
          return { rowCount: 0, rows: [] };
        }
        return {
          rowCount: 1,
          rows: [{ key_version: keyVersion }]
        };
      }
      throw new Error(`unexpected synthetic query: ${text}`);
    },
    release(error) {
      state.releases.push(error);
    }
  };
  return {
    addCredentialReference(keyVersion) {
      state.credentialReferences.add(keyVersion);
    },
    registerRow,
    removeCredentialReference(keyVersion) {
      state.credentialReferences.delete(keyVersion);
    },
    state,
    pool: {
      async connect() {
        return client;
      }
    }
  };
}

test("authority markers preserve the exact 2A schema and runtime contract", () => {
  for (const [file, expected] of Object.entries(immutableHashes)) {
    const relative = file === "checksums.json"
      ? `db/migrations/${file}`
      : `db/migrations/${file}`;
    assert.equal(sha256(relative), expected);
  }
  assert.equal(
    fs.existsSync(
      path.join(
        root,
        "db/migrations/0004_vault_key_rotation_authority.up.sql"
      )
    ),
    false
  );
  assert.equal(
    sha256("src/persistence/postgres/runtime-validation.js"),
    RUNTIME_2A_VALIDATOR_SHA256
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
  assert.doesNotThrow(() =>
    validateContractRows(
      manifest.map((migration) => ({
        version: migration.version,
        checksum_sha256: migration.sha256
      })),
      manifest
    )
  );
  assert.ok(V2.length <= 50);
  assert.match(V2, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/);

  const digest = versionDigest(V2);
  assert.equal(digest.length, 32);
  const markers = [
    activeMarker(1, digest),
    retirementMarker(versionDigest(V1))
  ];
  for (const marker of markers) {
    assert.ok(marker.length <= 50);
    assert.match(marker, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/);
  }
  const state = parseRegistryRows([
    { key_version: V2, registered_at: new Date() },
    ...markers.map((key_version) => ({
      key_version,
      registered_at: new Date()
    }))
  ]);
  assert.equal(state.active.digest, digest);
  assert.equal(state.operationalByDigest.get(digest), V2);
});

test("legacy and reserved labels are refused by operational vaults", () => {
  const encodedKey = Buffer.alloc(32, 7).toString("base64");
  assert.throws(
    () =>
      parseVaultKeyring({
        SOCIAL_VAULT_ACTIVE_KEY_VERSION: "v1",
        SOCIAL_VAULT_KEYS_JSON: JSON.stringify({
          v1: encodedKey
        }),
        SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT: "A".repeat(43)
      }),
    { code: "key_version_invalid" }
  );
  assert.throws(
    () =>
      createSocialVault({
        keyring: {
          activeVersion: "ia.h.synthetic",
          keys: new Map([["ia.h.synthetic", Buffer.alloc(32, 7)]])
        },
        expectedKeyringFingerprint: "A".repeat(43)
      }),
    { code: "key_version_invalid" }
  );
});

test("global authority is monotonic, serialized and idempotent for current target", async () => {
  const harness = authorityPool();
  const admin = createVaultKeyRegistryAdmin({ pool: harness.pool });
  await admin.register({ keyVersion: V1 });
  const first = await admin.withActiveVersion(
    { keyVersion: V1 },
    async (authority) => authority
  );
  assert.equal(first.authority.activeKeyVersion, V1);
  assert.equal(first.authority.generation, 1);
  assert.equal(first.authority.activated, true);

  const repeated = await admin.withActiveVersion(
    {
      keyVersion: V1,
      expectedActiveKeyVersion: V3
    },
    async (authority) => authority
  );
  assert.equal(repeated.authority.generation, 1);
  assert.equal(repeated.authority.activated, false);

  await admin.register({ keyVersion: V2 });
  const second = await admin.withActiveVersion(
    { keyVersion: V2, expectedActiveKeyVersion: V1 },
    async (authority) => authority
  );
  assert.equal(second.authority.activeKeyVersion, V2);
  assert.equal(second.authority.generation, 2);

  await admin.register({ keyVersion: V3 });
  await assert.rejects(
    admin.withActiveVersion(
      { keyVersion: V3, expectedActiveKeyVersion: V1 },
      async () => true
    ),
    { code: "vault_key_activation_conflict" }
  );
  await assert.rejects(
    admin.withActiveVersion(
      { keyVersion: V1, expectedActiveKeyVersion: V2 },
      async () => true
    ),
    { code: "vault_key_activation_downgrade" }
  );
  await admin.register({ keyVersion: V1_DIFFERENT_MATERIAL });
  await assert.rejects(
    admin.withActiveVersion(
      {
        keyVersion: V1_DIFFERENT_MATERIAL,
        expectedActiveKeyVersion: V2
      },
      async () => true
    ),
    { code: "vault_key_activation_generation_not_monotonic" }
  );
  const locks = harness.state.events.filter((entry) =>
    entry.text.includes("pg_advisory_lock")
  ).length;
  const unlocks = harness.state.events.filter((entry) =>
    entry.text.includes("pg_advisory_unlock")
  ).length;
  assert.equal(locks, unlocks);
  assert.equal(
    harness.state.events.some((entry) =>
      entry.text.startsWith(
        "DELETE FROM ia4tube_social_admin.vault_key_versions"
      )
    ),
    false
  );
  assert.equal(
    (await admin.currentAuthority()).activeKeyVersion,
    V2
  );
});

test("a failed administrative rollback discards the unsafe pooled session", async () => {
  const releases = [];
  const client = {
    async query(text) {
      if (text.includes("pg_advisory_lock")) {
        return { rowCount: 1, rows: [{}] };
      }
      if (text.includes("pg_advisory_unlock")) {
        return { rowCount: 1, rows: [{ unlocked: true }] };
      }
      if (
        text === "BEGIN" ||
        text === 'SET LOCAL ROLE "ia4tube_social_owner"'
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (text === "ROLLBACK") {
        throw new Error("synthetic rollback failure");
      }
      if (text.startsWith("SELECT key_version, registered_at")) {
        throw new Error("synthetic operation failure");
      }
      throw new Error("unexpected synthetic query");
    },
    release(error) {
      releases.push(error);
    }
  };
  const admin = createVaultKeyRegistryAdmin({
    pool: {
      async connect() {
        return client;
      }
    }
  });

  await assert.rejects(
    admin.register({ keyVersion: V1 }),
    { code: "vault_key_admin_rollback_failed" }
  );
  assert.equal(releases.length, 1);
  assert.equal(
    releases[0]?.code,
    "vault_key_admin_rollback_failed"
  );
});

test("partial operation keeps authority active so an idempotent retry can resume", async () => {
  const harness = authorityPool();
  const admin = createVaultKeyRegistryAdmin({ pool: harness.pool });
  await admin.register({ keyVersion: V2 });
  const interruption = new Error("synthetic operation interruption");
  await assert.rejects(
    admin.withActiveVersion(
      { keyVersion: V2 },
      async () => {
        throw interruption;
      }
    ),
    interruption
  );
  const retried = await admin.withActiveVersion(
    { keyVersion: V2 },
    async () => "resumed"
  );
  assert.equal(retried.authority.activated, false);
  assert.equal(retried.result, "resumed");
});

test("retirement remains FK-protected, idempotent and irreversible", async () => {
  const harness = authorityPool();
  const admin = createVaultKeyRegistryAdmin({ pool: harness.pool });
  await admin.register({ keyVersion: V1 });
  await admin.withActiveVersion(
    { keyVersion: V1 },
    async () => true
  );
  await admin.register({ keyVersion: V2 });
  await admin.withActiveVersion(
    { keyVersion: V2, expectedActiveKeyVersion: V1 },
    async () => true
  );

  harness.addCredentialReference(V1);
  await assert.rejects(admin.retire({ keyVersion: V1 }), {
    code: "vault_key_version_in_use"
  });
  harness.removeCredentialReference(V1);
  assert.deepEqual(await admin.retire({ keyVersion: V1 }), {
    keyVersion: V1,
    retired: true
  });
  assert.deepEqual(await admin.retire({ keyVersion: V1 }), {
    keyVersion: V1,
    retired: false
  });
  await assert.rejects(admin.register({ keyVersion: V1 }), {
    code: "vault_key_version_retired"
  });
  await assert.rejects(admin.retire({ keyVersion: V2 }), {
    code: "vault_active_key_retirement_refused"
  });
});

test("malformed, ambiguous and colliding marker state fails closed", () => {
  const now = new Date();
  assert.throws(
    () =>
      parseRegistryRows([
        { key_version: V1, registered_at: now },
        { key_version: "ia.unknown", registered_at: now }
      ]),
    { code: "vault_key_authority_corrupt" }
  );
  const digest = versionDigest(V1);
  assert.throws(
    () =>
      parseRegistryRows([
        { key_version: V1, registered_at: now },
        { key_version: activeMarker(1, digest), registered_at: now },
        { key_version: activeMarker(2, digest), registered_at: now }
      ]),
    { code: "vault_key_authority_corrupt" }
  );
  assert.throws(
    () =>
      parseRegistryRows([
        { key_version: activeMarker(1, digest), registered_at: now }
      ]),
    { code: "vault_key_authority_corrupt" }
  );
  assert.throws(
    () =>
      parseRegistryRows(
        [
          { key_version: V1, registered_at: now },
          { key_version: V2, registered_at: now }
        ],
        { versionDigest: () => "A".repeat(32) }
    ),
    { code: "vault_key_version_digest_collision" }
  );
  assert.throws(
    () =>
      parseRegistryRows([
        { key_version: V1, registered_at: now },
        {
          key_version: retirementMarker(digest),
          registered_at: now
        }
      ]),
    { code: "vault_key_authority_corrupt" }
  );
});
