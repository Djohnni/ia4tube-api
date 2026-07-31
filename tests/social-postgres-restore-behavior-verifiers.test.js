"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  GLOBAL_VAULT_BACKFILL_POLICY
} = require("../src/persistence/postgres/migrations");
const {
  POLICY_PREFIX,
  targetFingerprint
} = require("../src/persistence/postgres/backup-restore");
const {
  CREDENTIAL_INVENTORY_POLICY
} = require("../src/persistence/postgres/vault-key-registry-admin");
const {
  createSocialCredentialService
} = require("../src/social/credential-service");
const {
  createSocialVault
} = require("../src/social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");
const {
  createVaultKeyRotationService
} = require("../src/social/vault-key-rotation-service");
const {
  loadSystemPostgresTls
} = require("../src/persistence/postgres/tls");
const {
  LEGACY_2A_COMMIT,
  LEGACY_2A_MODULES,
  LEGACY_2A_SOURCE_MANIFEST,
  RestoreBehaviorVerifierError,
  createRestoreBehaviorVerifiers,
  inspectSeparatedTargets,
  poolConfiguration,
  verifyLegacy2ASourceManifest
} = require(
  "../src/persistence/postgres/restore-behavior-verifiers"
);

const MIGRATION_LOGIN = "synthetic_migration_login";
const RUNTIME_LOGIN = "synthetic_runtime_login";
const DATABASE = "ia4tube_social_disposable_restore";
const PASSWORD = "Synthetic-Password-Only-123!";
const MIGRATION_URL =
  `postgresql://${MIGRATION_LOGIN}:${PASSWORD}` +
  `@synthetic-db.example.test:5432/${DATABASE}?sslmode=verify-full`;
const RUNTIME_URL =
  `postgresql://${RUNTIME_LOGIN}:${PASSWORD}` +
  `@synthetic-db.example.test:5432/${DATABASE}?sslmode=verify-full`;

function codedError(code, properties = {}) {
  return Object.assign(new Error(code), { code, ...properties });
}

function cloneRow(row) {
  if (!row) return null;
  const result = { ...row };
  for (const field of ["ciphertext", "nonce", "auth_tag"]) {
    if (Buffer.isBuffer(result[field])) {
      result[field] = Buffer.from(result[field]);
    }
  }
  return Object.freeze(result);
}

function makeRepository(world) {
  function credentialKey(companyId, credentialId) {
    return `${companyId}/${credentialId}`;
  }

  function connectionKey(companyId, connectionId) {
    return `${companyId}/${connectionId}`;
  }

  async function createConnection(input) {
    const row = {
      company_id: input.companyId,
      id: input.id,
      provider: input.provider,
      status: "pending",
      revision: 1
    };
    world.connections.set(
      connectionKey(input.companyId, input.id),
      row
    );
    return Object.freeze({ ...row });
  }

  async function findConnection(input) {
    const row = world.connections.get(
      connectionKey(input.companyId, input.connectionId)
    );
    return row ? Object.freeze({ ...row }) : null;
  }

  async function storeEncryptedCredential(input) {
    if (!world.registry.registered.has(input.keyVersion)) {
      throw codedError("23503", {
        constraint: "social_encrypted_credentials_key_version_fk"
      });
    }
    const key = credentialKey(input.companyId, input.id);
    const row = {
      company_id: input.companyId,
      id: input.id,
      provider: input.provider,
      connection_id: input.connectionId || null,
      oauth_transaction_id: input.oauthTransactionId || null,
      credential_type: input.credentialType,
      ciphertext: Buffer.from(input.ciphertext),
      nonce: Buffer.from(input.nonce),
      auth_tag: Buffer.from(input.authTag),
      key_version: input.keyVersion,
      aad_version: input.aadVersion,
      expires_at: input.expiresAt || null,
      revoked_at: null,
      revision: 1
    };
    world.credentials.set(key, row);
    return cloneRow(row);
  }

  async function findEncryptedCredential(input) {
    const row = world.credentials.get(
      credentialKey(input.companyId, input.credentialId)
    );
    return cloneRow(row);
  }

  async function rotateCredential(input) {
    const key = credentialKey(input.companyId, input.credentialId);
    const row = world.credentials.get(key);
    if (!row || Number(row.revision) !== Number(input.expectedRevision)) {
      throw codedError("credential_rotation_conflict");
    }
    if (!world.registry.registered.has(input.keyVersion)) {
      throw codedError("23503", {
        constraint: "social_encrypted_credentials_key_version_fk"
      });
    }
    Object.assign(row, {
      ciphertext: Buffer.from(input.ciphertext),
      nonce: Buffer.from(input.nonce),
      auth_tag: Buffer.from(input.authTag),
      key_version: input.keyVersion,
      revision: Number(row.revision) + 1
    });
    return cloneRow(row);
  }

  async function listCredentialKeyVersions(input) {
    const counts = new Map();
    for (const row of world.credentials.values()) {
      if (row.company_id !== input.companyId) continue;
      counts.set(
        row.key_version,
        (counts.get(row.key_version) || 0) + 1
      );
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([keyVersion, credentialCount]) =>
        Object.freeze({ keyVersion, credentialCount })
      );
  }

  return Object.freeze({
    createConnection,
    findConnection,
    findEncryptedCredential,
    findEncryptedCredentialForKeyRotation: findEncryptedCredential,
    listCredentialKeyVersions,
    rotateEncryptedCredential: rotateCredential,
    rotateEncryptedCredentialForKeyRotation: rotateCredential,
    storeEncryptedCredential
  });
}

function makeRegistry(world) {
  async function register({ keyVersion }) {
    const registered = !world.registry.registered.has(keyVersion);
    world.registry.registered.add(keyVersion);
    return Object.freeze({ keyVersion, registered });
  }

  async function currentAuthority() {
    return world.registry.active
      ? Object.freeze({
          activeKeyVersion: world.registry.active,
          generation: world.registry.generation
        })
      : null;
  }

  async function withActiveVersion(input, operation) {
    if (
      world.registry.active &&
      world.registry.active !== input.keyVersion &&
      world.registry.active !== input.expectedActiveKeyVersion
    ) {
      throw codedError("vault_key_activation_conflict");
    }
    if (
      !world.registry.active &&
      input.expectedActiveKeyVersion !== null
    ) {
      throw codedError("vault_key_authority_uninitialized");
    }
    const activated = world.registry.active !== input.keyVersion;
    if (activated) {
      world.registry.active = input.keyVersion;
      world.registry.generation += 1;
    }
    const authority = Object.freeze({
      activeKeyVersion: input.keyVersion,
      generation: world.registry.generation,
      activated
    });
    return Object.freeze({
      authority,
      result: await operation(authority)
    });
  }

  async function retire({ keyVersion }) {
    if (world.registry.active === keyVersion) {
      throw codedError("vault_active_key_retirement_refused");
    }
    for (const row of world.credentials.values()) {
      if (row.key_version === keyVersion) {
        throw codedError("vault_key_version_in_use");
      }
    }
    if (!world.registry.registered.delete(keyVersion)) {
      throw codedError("vault_key_version_not_registered");
    }
    world.registry.retired.add(keyVersion);
    return Object.freeze({ keyVersion, retired: true });
  }

  return Object.freeze({
    currentAuthority,
    register,
    retire,
    withActiveVersion
  });
}

function createSyntheticWorld(options = {}) {
  const generatedBuffers = [];
  const calls = [];
  const pools = [];
  const companies = new Map();
  const memberships = new Map();
  const connections = new Map();
  const credentials = new Map();
  const existingKey = Buffer.alloc(32, 77);
  const existingVersion = deriveVaultKeyVersion(77, existingKey);
  existingKey.fill(0);
  const world = {
    calls,
    companies,
    connections,
    credentials,
    generatedBuffers,
    memberships,
    pools,
    registry: {
      active: existingVersion,
      generation: 7,
      registered: new Set([existingVersion]),
      retired: new Set()
    },
    transientPolicyCount: options.transientPolicyCount || 0
  };
  const repository = makeRepository(world);
  const registry = makeRegistry(world);

  class FakePool {
    constructor(configuration) {
      this.configuration = configuration;
      this.ended = 0;
      this.kind = configuration.application_name.endsWith("migration")
        ? "migration"
        : "runtime";
      pools.push(this);
    }

    async end() {
      this.ended += 1;
    }
  }

  async function query(pool, transactionOptions, sql, parameters = []) {
    const text = String(sql);
    calls.push({
      kind: pool.kind,
      role: transactionOptions.role || null,
      companyId: transactionOptions.companyId || null,
      sql: text,
      parameters
    });

    if (text.includes("INSERT INTO ia4tube_social.companies")) {
      companies.set(parameters[0], {
        id: parameters[0],
        name: "Synthetic Restore Gate",
        status: "active",
        identity_derivation_version: parameters[1]
      });
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("INSERT INTO ia4tube_social.users")) {
      return { rowCount: 1, rows: [] };
    }
    if (
      text.includes(
        "INSERT INTO ia4tube_social.company_memberships"
      )
    ) {
      memberships.set(`${parameters[0]}/${parameters[1]}`, {
        company_id: parameters[0],
        user_id: parameters[1],
        role: "owner",
        status: "active"
      });
      return { rowCount: 1, rows: [] };
    }
    if (
      text.includes("UPDATE ia4tube_social.social_connections")
    ) {
      const row = connections.get(`${parameters[0]}/${parameters[1]}`);
      if (!row) return { rowCount: 0, rows: [] };
      row.status = "active";
      return { rowCount: 1, rows: [{ id: row.id }] };
    }
    if (
      text.includes("SELECT id::text") &&
      text.includes("FROM ia4tube_social.companies")
    ) {
      const visible = parameters[0].filter(
        (id) =>
          id === transactionOptions.companyId && companies.has(id)
      );
      return {
        rowCount: visible.length,
        rows: visible.sort().map((id) => ({ id }))
      };
    }
    if (
      text.includes("COUNT(*)::integer AS visible") &&
      text.includes("FROM ia4tube_social.companies")
    ) {
      const visible = transactionOptions.companyId
        ? parameters[0].filter(
            (id) =>
              id === transactionOptions.companyId && companies.has(id)
          ).length
        : 0;
      return { rowCount: 1, rows: [{ visible }] };
    }
    if (
      text.includes(
        "INSERT INTO ia4tube_social.social_connections"
      )
    ) {
      if (parameters[0] !== transactionOptions.companyId) {
        throw codedError("42501");
      }
      return { rowCount: 1, rows: [] };
    }
    if (
      text.includes("pg_backend_pid()") &&
      text.includes("own_visible")
    ) {
      const current = transactionOptions.companyId;
      return {
        rowCount: 1,
        rows: [
          {
            backend_pid:
              current === parameters[0] ? parameters[0] : parameters[1],
            scope: current,
            own_visible:
              current === parameters[0] && companies.has(parameters[0]),
            foreign_visible:
              current === parameters[1] && companies.has(parameters[1])
          }
        ]
      };
    }
    if (text.includes("FROM pg_catalog.pg_policies")) {
      world.policyParameters = parameters;
      return {
        rowCount: 1,
        rows: [{ transient_count: world.transientPolicyCount }]
      };
    }
    throw new Error("unexpected synthetic query");
  }

  const dependencies = {
    PoolClass: FakePool,
    createCompanyScopedRepository() {
      throw new Error("current company repository is not used");
    },
    createSocialCredentialService,
    createSocialRepository() {
      calls.push({ event: "current_repository_created" });
      return repository;
    },
    createSocialVault,
    createVaultKeyRegistryAdmin() {
      calls.push({ event: "registry_created" });
      return registry;
    },
    createVaultKeyRotationService,
    deriveVaultKeyVersion,
    async verifyRuntimeRole(pool, role) {
      calls.push({ event: "current_role", kind: pool.kind, role });
      return true;
    },
    async verifyRuntimeSchema(pool, role) {
      calls.push({ event: "current_schema", kind: pool.kind, role });
      return true;
    },
    vaultKeyringFingerprint,
    async withTransaction(pool, operation, transactionOptions = {}) {
      return operation({
        query: (sql, parameters) =>
          query(pool, transactionOptions, sql, parameters)
      });
    }
  };

  const legacy = {
    createCompanyScopedRepository() {
      calls.push({ event: "legacy_company_repository_created" });
      return Object.freeze({
        async findCompanyById(companyId) {
          const row = companies.get(companyId);
          return row ? Object.freeze({ ...row }) : null;
        },
        async findMembership({ companyId, userId }) {
          const row = memberships.get(`${companyId}/${userId}`);
          return row ? Object.freeze({ ...row }) : null;
        }
      });
    },
    createSocialCredentialService(optionsForService) {
      calls.push({ event: "legacy_credential_service_created" });
      return createSocialCredentialService(optionsForService);
    },
    createSocialRepository() {
      calls.push({ event: "legacy_social_repository_created" });
      return repository;
    },
    createSocialVault({ keyring }) {
      calls.push({ event: "legacy_vault_created" });
      return createSocialVault({
        keyring,
        expectedKeyringFingerprint: vaultKeyringFingerprint(
          keyring.activeVersion,
          [...keyring.keys.keys()]
        )
      });
    },
    async verifyRuntimeRole(pool, role) {
      calls.push({ event: "legacy_role", kind: pool.kind, role });
      return true;
    },
    async verifyRuntimeSchema(pool, role) {
      calls.push({ event: "legacy_schema", kind: pool.kind, role });
      return true;
    }
  };

  let uuid = 0;
  function randomUuid() {
    uuid += 1;
    return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
  }

  let randomByte = 0;
  function randomBytes(length) {
    randomByte += 1;
    const value = Buffer.alloc(length, randomByte);
    generatedBuffers.push(value);
    return value;
  }

  return {
    dependencies,
    legacy,
    randomBytes,
    randomInt: () => 41,
    randomUuid,
    repository,
    world
  };
}

function createGate(worldOptions = {}) {
  const synthetic = createSyntheticWorld(worldOptions);
  const gate = createRestoreBehaviorVerifiers({
    env: {},
    migrationDatabaseUrl: MIGRATION_URL,
    runtimeDatabaseUrl: RUNTIME_URL,
    expectedMigrationLogin: MIGRATION_LOGIN,
    expectedRuntimeLogin: RUNTIME_LOGIN,
    dependencies: synthetic.dependencies,
    legacyDependencies: synthetic.legacy,
    randomBytes: synthetic.randomBytes,
    randomInt: synthetic.randomInt,
    randomUuid: synthetic.randomUuid
  });
  return { gate, ...synthetic };
}

test("targets require separate exact logins and verified TLS", () => {
  const targets = inspectSeparatedTargets({
    migrationDatabaseUrl: MIGRATION_URL,
    runtimeDatabaseUrl: RUNTIME_URL,
    expectedMigrationLogin: MIGRATION_LOGIN,
    expectedRuntimeLogin: RUNTIME_LOGIN
  });
  assert.equal(targets.migration.database, DATABASE);
  assert.equal(targets.runtime.database, DATABASE);
  assert.equal(targets.migration.login, MIGRATION_LOGIN);
  assert.equal(targets.runtime.login, RUNTIME_LOGIN);
  assert.equal(
    targets.migration.connectionString.includes("sslmode"),
    false
  );

  assert.throws(
    () =>
      inspectSeparatedTargets({
        migrationDatabaseUrl: MIGRATION_URL,
        runtimeDatabaseUrl: MIGRATION_URL,
        expectedMigrationLogin: MIGRATION_LOGIN,
        expectedRuntimeLogin: MIGRATION_LOGIN
      }),
    {
      code: "restore_behavior_principal_separation_refused",
      name: "RestoreBehaviorVerifierError"
    }
  );
  assert.throws(
    () =>
      inspectSeparatedTargets({
        migrationDatabaseUrl: MIGRATION_URL.replace(
          "verify-full",
          "require"
        ),
        runtimeDatabaseUrl: RUNTIME_URL,
        expectedMigrationLogin: MIGRATION_LOGIN,
        expectedRuntimeLogin: RUNTIME_LOGIN
      }),
    {
      code: "restore_behavior_migration_target_refused",
      name: "RestoreBehaviorVerifierError"
    }
  );
});

test("pool boundary fixes migration at one and runtime at two", () => {
  const target = inspectSeparatedTargets({
    migrationDatabaseUrl: MIGRATION_URL,
    runtimeDatabaseUrl: RUNTIME_URL,
    expectedMigrationLogin: MIGRATION_LOGIN,
    expectedRuntimeLogin: RUNTIME_LOGIN
  });
  const ssl = loadSystemPostgresTls(
    {},
    target.runtime.host
  );
  const migration = poolConfiguration(
    target.migration,
    "synthetic-migration",
    1,
    ssl
  );
  const runtime = poolConfiguration(
    target.runtime,
    "synthetic-runtime",
    2,
    ssl
  );
  assert.equal(migration.max, 1);
  assert.equal(runtime.max, 2);
  assert.equal(migration.ssl.rejectUnauthorized, true);
  assert.equal(runtime.ssl.minVersion, "TLSv1.2");
  assert.equal(
    Object.prototype.hasOwnProperty.call(migration.ssl, "ca"),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(runtime.ssl, "ca"),
    false
  );
  assert.match(migration.options, /search_path=pg_catalog/);
});

test("legacy 2A provenance rejects a one-byte source change", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-legacy-2a-manifest-")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = path.join(root, "src", "legacy");
  fs.mkdirSync(scope, { recursive: true });
  const runtime = path.join(scope, "runtime.js");
  const packageFile = path.join(root, "package.json");
  fs.writeFileSync(runtime, "module.exports=1;\n");
  fs.writeFileSync(packageFile, "{}\n");
  const digest = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const manifest = {
    format: 1,
    kind: "ia4tube-social-legacy-2a-source-manifest",
    commit: "a".repeat(40),
    scopes: ["src/legacy"],
    files: {
      "package.json": digest(packageFile),
      "src/legacy/runtime.js": digest(runtime)
    }
  };
  const verified = verifyLegacy2ASourceManifest(root, manifest);
  assert.equal(verified.commit, manifest.commit);
  assert.equal(verified.files, 2);
  assert.match(verified.manifestSha256, /^[0-9a-f]{64}$/);

  fs.writeFileSync(runtime, "module.exports=2;\n");
  assert.throws(
    () => verifyLegacy2ASourceManifest(root, manifest),
    {
      code: "restore_behavior_2a_source_hash_mismatch",
      name: "RestoreBehaviorVerifierError"
    }
  );
});

test("immutable manifest identifies the exact 2A runtime tree", () => {
  assert.equal(LEGACY_2A_COMMIT, "9deb1e04249026a7046d44d6cbf4e2da87b9a0a4");
  assert.equal(LEGACY_2A_SOURCE_MANIFEST.commit, LEGACY_2A_COMMIT);
  assert.equal(Object.keys(LEGACY_2A_SOURCE_MANIFEST.files).length, 21);
  const loaded = [
    LEGACY_2A_MODULES.pool,
    LEGACY_2A_MODULES.runtimeValidation,
    LEGACY_2A_MODULES.companyRepository,
    LEGACY_2A_MODULES.socialRepository,
    LEGACY_2A_MODULES.credentialService,
    LEGACY_2A_MODULES.vault
  ];
  assert.deepEqual(
    loaded,
    [
      LEGACY_2A_MODULES.pool,
      LEGACY_2A_MODULES.runtimeValidation,
      LEGACY_2A_MODULES.companyRepository,
      LEGACY_2A_MODULES.socialRepository,
      LEGACY_2A_MODULES.credentialService,
      LEGACY_2A_MODULES.vault
    ]
  );
  assert.equal(
    loaded.some((modulePath) => modulePath.includes("migrations")),
    false
  );
});

test("restore behavior proves RLS, vault lifecycle and exact 2A bridge", async () => {
  const { gate, world } = createGate();
  try {
    assert.equal(
      gate.verifiers.verifierTargetFingerprint,
      targetFingerprint({
        host: "synthetic-db.example.test",
        port: "5432",
        database: DATABASE
      })
    );
    assert.equal(
      await gate.verifiers.verifyRuntimeIsolation(),
      true
    );
    assert.equal(await gate.verifiers.verifyVault(), true);
    assert.equal(
      await gate.verifiers.verify2ACompatibility(),
      true
    );

    assert.equal(world.pools.length, 2);
    assert.equal(world.pools[0].configuration.max, 1);
    assert.equal(world.pools[1].configuration.max, 2);
    assert.equal(world.registry.retired.size, 1);
    assert.ok(
      [...world.credentials.values()].every(
        (row) => row.key_version === world.registry.active
      )
    );
    assert.deepEqual(world.policyParameters, [
      POLICY_PREFIX,
      [
        GLOBAL_VAULT_BACKFILL_POLICY,
        CREDENTIAL_INVENTORY_POLICY
      ]
    ]);
    assert.equal(
      world.calls.filter((entry) => entry.event === "legacy_role")
        .length,
      1
    );
    assert.equal(
      world.calls.filter((entry) => entry.event === "legacy_schema")
        .length,
      2
    );
    assert.equal(
      world.calls.filter(
        (entry) => entry.event === "legacy_vault_created"
      ).length,
      1
    );
    const concurrent = world.calls.filter((entry) =>
      String(entry.sql || "").includes("pg_backend_pid()")
    );
    assert.equal(concurrent.length, 2);
    assert.notEqual(concurrent[0].companyId, concurrent[1].companyId);
  } finally {
    await gate.close();
  }

  assert.ok(world.pools.every((pool) => pool.ended === 1));
  assert.ok(
    world.generatedBuffers.every((buffer) =>
      buffer.every((value) => value === 0)
    )
  );
  await gate.close();
  assert.ok(world.pools.every((pool) => pool.ended === 1));
});

test("final transient policy refusal still wipes memory and closes pools", async () => {
  const { gate, world } = createGate({ transientPolicyCount: 1 });
  try {
    assert.equal(
      await gate.verifiers.verifyRuntimeIsolation(),
      true
    );
    assert.equal(await gate.verifiers.verifyVault(), true);
    await assert.rejects(
      gate.verifiers.verify2ACompatibility(),
      {
        code: "restore_behavior_transient_policy_remained",
        name: "RestoreBehaviorVerifierError"
      }
    );
  } finally {
    await gate.close();
  }
  assert.ok(world.pools.every((pool) => pool.ended === 1));
  assert.ok(
    world.generatedBuffers.every((buffer) =>
      buffer.every((value) => value === 0)
    )
  );
});

test("verifier order and closed state fail with stable safe codes", async () => {
  const first = createGate();
  try {
    await assert.rejects(first.gate.verifiers.verifyVault(), {
      code: "restore_behavior_runtime_gate_required",
      name: "RestoreBehaviorVerifierError"
    });
  } finally {
    await first.gate.close();
  }

  await assert.rejects(
    first.gate.verifiers.verifyRuntimeIsolation(),
    {
      code: "restore_behavior_verifier_closed",
      name: "RestoreBehaviorVerifierError"
    }
  );
  assert.ok(
    first.world.generatedBuffers.every((buffer) =>
      buffer.every((value) => value === 0)
    )
  );
  assert.equal(
    new RestoreBehaviorVerifierError("synthetic").message,
    "synthetic"
  );
});
