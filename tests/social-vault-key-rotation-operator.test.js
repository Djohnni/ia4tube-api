"use strict";

const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  databaseTargetFingerprint,
  parseDatabaseUrl
} = require("../src/persistence/postgres/config");
const {
  CREDENTIAL_INVENTORY_POLICY,
  createVaultKeyRegistryAdmin
} = require("../src/persistence/postgres/vault-key-registry-admin");
const {
  PRODUCTION_ROTATION_APPROVAL,
  clearParsedKeyring,
  createVaultRotationOperator,
  loadVaultRotationOperatorConfig,
  parseVaultRotationArguments,
  runVaultRotationCli,
  safeCliLogger
} = require("../src/social/vault-key-rotation-operator");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");

const ENVIRONMENT_ID =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_A1 =
  "33333333-3333-4333-8333-333333333331";
const CREDENTIAL_A2 =
  "33333333-3333-4333-8333-333333333332";
const CREDENTIAL_B1 =
  "44444444-4444-4444-8444-444444444441";
const SYNTHETIC_SECRET = "synthetic-operator-secret-never-print";

function key(byte) {
  return Buffer.alloc(32, byte);
}

const V1 = deriveVaultKeyVersion(1, key(1));
const V2 = deriveVaultKeyVersion(2, key(2));
const KEYRING_FINGERPRINT = vaultKeyringFingerprint(V2, [V1, V2]);

function operatorEnvironment(overrides = {}) {
  const migrationUrl =
    "postgresql://rotation_migration:" +
    "Synthetic-Migration-Password-2026!" +
    "@db.example.test:5432/ia4tube_social" +
    "?sslmode=verify-full";
  const runtimeUrl =
    "postgresql://rotation_runtime:" +
    "Synthetic-Runtime-Password-2026!" +
    "@db.example.test:5432/ia4tube_social" +
    "?sslmode=verify-full";
  const targetFingerprint = databaseTargetFingerprint(
    parseDatabaseUrl(migrationUrl, "test_database_url")
  );
  return {
    NODE_ENV: "test",
    SOCIAL_VAULT_ROTATION_ACTIVE_KEY_VERSION: V2,
    SOCIAL_VAULT_ROTATION_APPROVAL:
      `ROTATE_SOCIAL_VAULT:${ENVIRONMENT_ID}`,
    SOCIAL_VAULT_ROTATION_BATCH_SIZE: "2",
    SOCIAL_VAULT_ROTATION_ENVIRONMENT: "staging",
    SOCIAL_VAULT_ROTATION_EXPECTED_CURRENT_KEY_VERSION: V1,
    SOCIAL_VAULT_ROTATION_EXPECTED_ENVIRONMENT_ID: ENVIRONMENT_ID,
    SOCIAL_VAULT_ROTATION_EXPECTED_KEYRING_FINGERPRINT:
      KEYRING_FINGERPRINT,
    SOCIAL_VAULT_ROTATION_EXPECTED_MIGRATION_LOGIN:
      "rotation_migration",
    SOCIAL_VAULT_ROTATION_EXPECTED_RUNTIME_LOGIN:
      "rotation_runtime",
    SOCIAL_VAULT_ROTATION_EXPECTED_TARGET_FINGERPRINT:
      targetFingerprint,
    SOCIAL_VAULT_ROTATION_IDENTITY_DERIVATION_VERSION: "v1",
    SOCIAL_VAULT_ROTATION_KEYS_JSON: JSON.stringify({
      [V1]: key(1).toString("base64"),
      [V2]: key(2).toString("base64")
    }),
    SOCIAL_VAULT_ROTATION_MIGRATIONS_DATABASE_URL: migrationUrl,
    SOCIAL_VAULT_ROTATION_RUNTIME_DATABASE_URL: runtimeUrl,
    ...overrides
  };
}

function captureStream() {
  const stream = new PassThrough();
  let value = "";
  stream.on("data", (chunk) => {
    value += chunk.toString("utf8");
  });
  return { stream, value: () => value };
}

test("CLI accepts only fixed non-secret arguments", () => {
  assert.deepEqual(parseVaultRotationArguments(["inventory"]), {
    mode: "inventory",
    retire: false
  });
  assert.deepEqual(parseVaultRotationArguments(["prepare"]), {
    mode: "prepare",
    retire: false
  });
  assert.deepEqual(
    parseVaultRotationArguments(["rotate", "--retire-previous"]),
    { mode: "rotate", retire: true }
  );
  for (const args of [
    [],
    ["rotate", "--key-version", V2],
    ["rotate", `--key=${SYNTHETIC_SECRET}`],
    ["rotate", "postgresql://example.invalid/database"],
    ["inventory", "--retire-previous"],
    ["prepare", "--retire-previous"],
    ["unknown"]
  ]) {
    assert.throws(
      () => parseVaultRotationArguments(args),
      (error) =>
        [
          "vault_rotation_arguments_invalid",
          "vault_rotation_mode_invalid"
        ].includes(error?.code)
    );
  }
});

test("operator config requires explicit approval, exact identities, and separate credentials", () => {
  const config = loadVaultRotationOperatorConfig(
    operatorEnvironment(),
    { mode: "rotate", retire: false }
  );
  try {
    assert.equal(config.environment, "staging");
    assert.equal(config.environmentId, ENVIRONMENT_ID);
    assert.equal(config.expectedCurrentKeyVersion, V1);
    assert.equal(config.keyring.activeVersion, V2);
    assert.equal(config.keyring.fingerprint, KEYRING_FINGERPRINT);
    assert.equal(config.migration.targetFingerprint, config.runtime.targetFingerprint);
    assert.equal(config.migration.target.username, "rotation_migration");
    assert.equal(config.runtime.login, "rotation_runtime");
    assert.equal(config.batchSize, 2);
  } finally {
    clearParsedKeyring(config.keyring);
  }

  const prepareConfig = loadVaultRotationOperatorConfig(
    operatorEnvironment({
      SOCIAL_VAULT_ROTATION_APPROVAL:
        `PREPARE_SOCIAL_VAULT:${ENVIRONMENT_ID}`
    }),
    { mode: "prepare", retire: false }
  );
  try {
    assert.equal(prepareConfig.mode, "prepare");
    assert.equal(prepareConfig.expectedCurrentKeyVersion, V1);
    assert.equal(prepareConfig.keyring.activeVersion, V2);
  } finally {
    clearParsedKeyring(prepareConfig.keyring);
  }

  assert.throws(
    () =>
      loadVaultRotationOperatorConfig(
        operatorEnvironment(),
        { mode: "prepare", retire: false }
      ),
    { code: "vault_rotation_not_approved" }
  );

  assert.throws(
    () =>
      loadVaultRotationOperatorConfig(
        operatorEnvironment({
          SOCIAL_VAULT_ROTATION_APPROVAL:
            `PREPARE_SOCIAL_VAULT:${ENVIRONMENT_ID}`,
          SOCIAL_VAULT_ROTATION_ENVIRONMENT: "production"
        }),
        { mode: "prepare", retire: false }
      ),
    { code: "vault_rotation_production_not_approved" }
  );

  const productionPrepareConfig =
    loadVaultRotationOperatorConfig(
      operatorEnvironment({
        SOCIAL_VAULT_ROTATION_APPROVAL:
          `PREPARE_SOCIAL_VAULT:${ENVIRONMENT_ID}`,
        SOCIAL_VAULT_ROTATION_ENVIRONMENT: "production",
        SOCIAL_VAULT_ROTATION_PRODUCTION_APPROVAL:
          PRODUCTION_ROTATION_APPROVAL
      }),
      { mode: "prepare", retire: false }
    );
  clearParsedKeyring(productionPrepareConfig.keyring);

  assert.throws(
    () =>
      loadVaultRotationOperatorConfig(
        operatorEnvironment({
          SOCIAL_VAULT_ROTATION_APPROVAL: "ROTATE_SOCIAL_VAULT:wrong"
        }),
        { mode: "rotate", retire: false }
      ),
    { code: "vault_rotation_not_approved" }
  );

  const samePassword =
    "Synthetic-Shared-Password-That-Must-Be-Rejected!";
  assert.throws(
    () =>
      loadVaultRotationOperatorConfig(
        operatorEnvironment({
          SOCIAL_VAULT_ROTATION_MIGRATIONS_DATABASE_URL:
            `postgresql://rotation_migration:${samePassword}` +
            "@db.example.test:5432/ia4tube_social",
          SOCIAL_VAULT_ROTATION_RUNTIME_DATABASE_URL:
            `postgresql://rotation_runtime:${samePassword}` +
            "@db.example.test:5432/ia4tube_social"
        }),
        { mode: "rotate", retire: false }
      ),
    {
      code: "vault_rotation_database_credentials_not_separated"
    }
  );

  assert.throws(
    () =>
      loadVaultRotationOperatorConfig(
        operatorEnvironment({
          SOCIAL_VAULT_ROTATION_EXPECTED_RUNTIME_LOGIN:
            "unexpected_runtime"
        }),
        { mode: "rotate", retire: false }
      ),
    { code: "vault_rotation_database_login_mismatch" }
  );

  for (const name of [
    "PGREPLICATION",
    "PGBINARY",
    "PGCLIENT_ENCODING",
    "PG_FUTURE_OVERRIDE"
  ]) {
    assert.throws(
      () =>
        loadVaultRotationOperatorConfig(
          operatorEnvironment({
            [name]: "synthetic-override"
          }),
          { mode: "rotate", retire: false }
        ),
      {
        code:
          "vault_rotation_postgres_environment_override_forbidden"
      }
    );
  }

  assert.throws(
    () =>
      loadVaultRotationOperatorConfig(
        operatorEnvironment({
          SOCIAL_VAULT_ROTATION_MIGRATIONS_DATABASE_URL:
            "postgresql://Rotation_Migration:" +
            "Synthetic-Migration-Password-2026!" +
            "@db.example.test:5432/ia4tube_social" +
            "?sslmode=verify-full"
        }),
        { mode: "rotate", retire: false }
      ),
    { code: "vault_rotation_login_invalid" }
  );

  assert.throws(
    () =>
      loadVaultRotationOperatorConfig(
        operatorEnvironment({
          SOCIAL_VAULT_ROTATION_EXPECTED_RUNTIME_LOGIN:
            "Rotation_Runtime"
        }),
        { mode: "rotate", retire: false }
      ),
    { code: "vault_rotation_database_login_mismatch" }
  );
});

test("owner inventory is globally ordered, paginated, and leaves no persistent policy", async () => {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql.startsWith("SELECT pg_advisory_lock")) {
        return { rows: [{}] };
      }
      if (sql === "BEGIN" || sql.startsWith("SET LOCAL ROLE")) {
        return { rows: [] };
      }
      if (sql.includes("FROM pg_catalog.pg_policy")) {
        return { rows: [{ policy_count: 0 }] };
      }
      if (sql.startsWith(`CREATE POLICY ${CREDENTIAL_INVENTORY_POLICY}`)) {
        return { rows: [] };
      }
      if (sql.includes("AS is_target_key")) {
        assert.deepEqual(parameters, [null, null, V2, 2]);
        return {
          rows: [
            {
              company_id: COMPANY_A,
              credential_id: CREDENTIAL_A1,
              is_target_key: false
            },
            {
              company_id: COMPANY_B,
              credential_id: CREDENTIAL_B1,
              is_target_key: true
            }
          ]
        };
      }
      if (sql.startsWith(`DROP POLICY ${CREDENTIAL_INVENTORY_POLICY}`)) {
        return { rows: [] };
      }
      if (sql === "COMMIT") return { rows: [] };
      if (sql.startsWith("SELECT pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] };
      }
      throw new Error("unexpected synthetic query");
    },
    release(error) {
      assert.equal(error, undefined);
      released = true;
    }
  };
  const admin = createVaultKeyRegistryAdmin({
    pool: {
      async connect() {
        return client;
      }
    }
  });
  const page = await admin.listCredentialInventoryPage({
    cursor: null,
    limit: 2,
    targetKeyVersion: V2
  });
  assert.deepEqual(page, {
    entries: [
      {
        companyId: COMPANY_A,
        credentialId: CREDENTIAL_A1,
        isTargetKey: false
      },
      {
        companyId: COMPANY_B,
        credentialId: CREDENTIAL_B1,
        isTargetKey: true
      }
    ],
    nextCursor: {
      companyId: COMPANY_B,
      credentialId: CREDENTIAL_B1
    },
    complete: false
  });
  assert.equal(released, true);
  const statements = queries.map((entry) => entry.sql);
  assert.ok(
    statements.findIndex((sql) => sql.startsWith("CREATE POLICY")) <
      statements.findIndex((sql) => sql.includes("AS is_target_key"))
  );
  assert.ok(
    statements.findIndex((sql) => sql.includes("AS is_target_key")) <
      statements.findIndex((sql) => sql.startsWith("DROP POLICY"))
  );
  assert.ok(
    statements.findIndex((sql) => sql.startsWith("DROP POLICY")) <
      statements.findIndex((sql) => sql === "COMMIT")
  );
});

test("an interrupted owner inventory rolls back its transient policy", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith("SELECT pg_advisory_lock")) {
        return { rows: [{}] };
      }
      if (sql === "BEGIN" || sql.startsWith("SET LOCAL ROLE")) {
        return { rows: [] };
      }
      if (sql.includes("FROM pg_catalog.pg_policy")) {
        return { rows: [{ policy_count: 0 }] };
      }
      if (sql.startsWith("CREATE POLICY")) return { rows: [] };
      if (sql.includes("AS is_target_key")) {
        const error = new Error(SYNTHETIC_SECRET);
        error.code = "synthetic_inventory_interrupted";
        throw error;
      }
      if (sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] };
      }
      throw new Error("unexpected synthetic query");
    },
    release() {}
  };
  const admin = createVaultKeyRegistryAdmin({
    pool: {
      async connect() {
        return client;
      }
    }
  });
  await assert.rejects(
    admin.listCredentialInventoryPage({
      cursor: null,
      limit: 2,
      targetKeyVersion: V2
    }),
    { code: "synthetic_inventory_interrupted" }
  );
  assert.ok(statements.includes("ROLLBACK"));
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(
    statements.some((sql) => sql.startsWith("DROP POLICY")),
    false
  );
  assert.ok(
    statements.some((sql) => sql.startsWith("SELECT pg_advisory_unlock"))
  );
});

function fakeOperatorDependencies({
  failOnce = false,
  persistRotations = true
} = {}) {
  const rows = [
    { companyId: COMPANY_A, credentialId: CREDENTIAL_A1, keyVersion: V1 },
    { companyId: COMPANY_A, credentialId: CREDENTIAL_A2, keyVersion: V1 },
    { companyId: COMPANY_B, credentialId: CREDENTIAL_B1, keyVersion: V1 }
  ];
  const events = [];
  const logs = [];
  let activeKeyVersion = V1;
  let generation = 1;
  let interrupted = failOnce;
  let retired = false;
  const registeredKeyVersions = new Set([V1]);
  const keyRegistryAdmin = {
    async currentAuthority() {
      events.push({ operation: "authority" });
      return { activeKeyVersion, generation };
    },
    async register({ keyVersion }) {
      events.push({ operation: "register", keyVersion });
      const registered = !registeredKeyVersions.has(keyVersion);
      registeredKeyVersions.add(keyVersion);
      return { keyVersion, registered };
    },
    async withActiveVersion(input, operation) {
      events.push({ operation: "activate", input });
      if (activeKeyVersion !== input.keyVersion) {
        assert.equal(activeKeyVersion, input.expectedActiveKeyVersion);
        activeKeyVersion = input.keyVersion;
        generation += 1;
      }
      const authority = {
        activeKeyVersion,
        generation,
        activated: generation === 2
      };
      return {
        authority,
        result: await operation(authority)
      };
    },
    async listCredentialInventoryPage({ cursor, limit, targetKeyVersion }) {
      events.push({ operation: "inventory-page" });
      const start = cursor
        ? rows.findIndex(
            (entry) =>
              entry.companyId === cursor.companyId &&
              entry.credentialId === cursor.credentialId
          ) + 1
        : 0;
      const slice = rows.slice(start, start + limit);
      const last = slice.at(-1);
      return {
        entries: slice.map((entry) => ({
          companyId: entry.companyId,
          credentialId: entry.credentialId,
          isTargetKey: entry.keyVersion === targetKeyVersion
        })),
        nextCursor: last
          ? {
              companyId: last.companyId,
              credentialId: last.credentialId
            }
          : null,
        complete: start + slice.length >= rows.length
      };
    }
  };
  const rotationService = {
    async rotateTenant({
      companyId,
      keyVersion,
      expectedActiveKeyVersion,
      credentialIds
    }) {
      events.push({
        operation: "rotate-tenant",
        companyId,
        credentialIds: [...credentialIds]
      });
      assert.equal(keyVersion, V2);
      assert.equal(expectedActiveKeyVersion, V1);
      let changed = 0;
      let alreadyCurrent = 0;
      for (const credentialId of credentialIds) {
        const row = rows.find(
          (candidate) =>
            candidate.companyId === companyId &&
            candidate.credentialId === credentialId
        );
        assert.ok(row, "credential must stay inside its tenant");
        if (interrupted && credentialId === CREDENTIAL_B1) {
          interrupted = false;
          const error = new Error(SYNTHETIC_SECRET);
          error.code = "synthetic_interruption";
          throw error;
        }
        if (row.keyVersion === V2) {
          alreadyCurrent += 1;
        } else {
          if (persistRotations) row.keyVersion = V2;
          changed += 1;
        }
      }
      return {
        credentials: credentialIds.length,
        changed,
        alreadyCurrent
      };
    },
    async retire({ keyVersion }) {
      events.push({ operation: "retire" });
      if (rows.some((row) => row.keyVersion === keyVersion)) {
        const error = new Error("synthetic key still in use");
        error.code = "vault_key_version_in_use";
        throw error;
      }
      retired = true;
      return { keyVersion, retired };
    }
  };
  const vault = {
    versions() {
      return {
        active: V2,
        readable: [V1, V2],
        fingerprint: KEYRING_FINGERPRINT
      };
    }
  };
  const operator = createVaultRotationOperator({
    keyRegistryAdmin,
    rotationService,
    vault,
    batchSize: 2,
    targetKeyVersion: V2,
    expectedCurrentKeyVersion: V1,
    expectedKeyringFingerprint: KEYRING_FINGERPRINT,
    logger: {
      info(entry) {
        logs.push(entry);
      },
      warn(entry) {
        logs.push(entry);
      }
    }
  });
  return { events, logs, operator, rows };
}

test("prepare registers the target idempotently without activation, inventory, or rotation", async () => {
  const dependencies = fakeOperatorDependencies();
  const first = await dependencies.operator.prepare();
  const repeated = await dependencies.operator.prepare();

  assert.deepEqual(first, {
    mode: "prepare",
    registered: true
  });
  assert.deepEqual(repeated, {
    mode: "prepare",
    registered: false
  });
  assert.equal(
    dependencies.rows.every((row) => row.keyVersion === V1),
    true
  );
  assert.equal(
    dependencies.events.filter(
      (entry) => entry.operation === "register"
    ).length,
    2
  );
  for (const forbidden of [
    "activate",
    "inventory-page",
    "rotate-tenant",
    "retire"
  ]) {
    assert.equal(
      dependencies.events.some(
        (entry) => entry.operation === forbidden
      ),
      false
    );
  }
  const serializedResult = JSON.stringify([first, repeated]);
  for (const secret of [
    V1,
    V2,
    KEYRING_FINGERPRINT,
    SYNTHETIC_SECRET
  ]) {
    assert.equal(serializedResult.includes(secret), false);
  }
});

test("prepare refuses a target that is already active without another registration", async () => {
  const dependencies = fakeOperatorDependencies();
  await dependencies.operator.rotate();
  const registrationsBefore = dependencies.events.filter(
    (entry) => entry.operation === "register"
  ).length;

  await assert.rejects(
    dependencies.operator.prepare(),
    { code: "vault_prepare_target_already_active" }
  );
  assert.equal(
    dependencies.events.filter(
      (entry) => entry.operation === "register"
    ).length,
    registrationsBefore
  );
});

test("rotation resumes by persisted key version and keeps A/B processing tenant-scoped", async () => {
  const dependencies = fakeOperatorDependencies({ failOnce: true });
  const originalFetch = global.fetch;
  let externalCalls = 0;
  global.fetch = async () => {
    externalCalls += 1;
    throw new Error("external call forbidden");
  };
  try {
    await assert.rejects(
      dependencies.operator.rotate(),
      { code: "synthetic_interruption" }
    );
    assert.equal(
      dependencies.rows.filter((row) => row.keyVersion === V2).length,
      2
    );

    const resumed = await dependencies.operator.rotate({
      retireKeyVersion: V1
    });
    assert.deepEqual(resumed, {
      mode: "rotate",
      pages: 2,
      companies: 2,
      credentials: 3,
      pendingBefore: 1,
      changed: 1,
      alreadyCurrent: 0,
      batches: 1,
      pendingAfter: 0,
      retired: true
    });
    assert.equal(
      dependencies.rows.every((row) => row.keyVersion === V2),
      true
    );
    assert.equal(externalCalls, 0);
    assert.ok(
      dependencies.events.findIndex(
        (entry) => entry.operation === "register"
      ) <
        dependencies.events.findIndex(
          (entry) => entry.operation === "activate"
        )
    );
    for (const event of dependencies.events.filter(
      (entry) => entry.operation === "rotate-tenant"
    )) {
      const companyIds = new Set(
        event.credentialIds.map(
          (credentialId) =>
            dependencies.rows.find(
              (row) => row.credentialId === credentialId
            ).companyId
        )
      );
      assert.deepEqual([...companyIds], [event.companyId]);
    }
    const serializedLogs = JSON.stringify(dependencies.logs);
    for (const forbidden of [
      COMPANY_A,
      COMPANY_B,
      CREDENTIAL_A1,
      CREDENTIAL_A2,
      CREDENTIAL_B1,
      V1,
      V2,
      KEYRING_FINGERPRINT,
      SYNTHETIC_SECRET
    ]) {
      assert.equal(serializedLogs.includes(forbidden), false);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("inventory is read-only and reports counts without identifiers or key versions", async () => {
  const dependencies = fakeOperatorDependencies();
  const result = await dependencies.operator.inventory();
  assert.deepEqual(result, {
    mode: "inventory",
    pages: 2,
    companies: 2,
    credentials: 3,
    current: 0,
    pending: 3,
    changed: 0,
    alreadyCurrent: 0,
    batches: 0
  });
  assert.equal(
    dependencies.events.some(
      (entry) =>
        entry.operation === "register" ||
        entry.operation === "activate" ||
        entry.operation === "rotate-tenant" ||
        entry.operation === "retire"
    ),
    false
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(COMPANY_A), false);
  assert.equal(serialized.includes(V1), false);
  assert.equal(serialized.includes(V2), false);
});

test("retirement is never attempted while the verified inventory still has pending rows", async () => {
  const dependencies = fakeOperatorDependencies({
    persistRotations: false
  });
  await assert.rejects(
    dependencies.operator.rotate({ retireKeyVersion: V1 }),
    { code: "vault_rotation_incomplete" }
  );
  assert.equal(
    dependencies.events.some((entry) => entry.operation === "retire"),
    false
  );
  assert.equal(
    dependencies.rows.every((row) => row.keyVersion === V1),
    true
  );
});

test("CLI emits counts or an error code only and never prints secret failure details", async () => {
  const prepareLog = captureStream();
  safeCliLogger(prepareLog.stream).info({
    component: "social_vault_rotation_operator",
    event: "target_registered",
    registered: true,
    keyVersion: V2,
    unsafeFutureField: SYNTHETIC_SECRET
  });
  assert.deepEqual(JSON.parse(prepareLog.value()), {
    level: "info",
    component: "social_vault_rotation_operator",
    event: "target_registered",
    registered: true
  });
  assert.equal(prepareLog.value().includes(V2), false);
  assert.equal(prepareLog.value().includes(SYNTHETIC_SECRET), false);

  const prepareOut = captureStream();
  const prepareErr = captureStream();
  const prepareCode = await runVaultRotationCli({
    argv: ["prepare"],
    env: {},
    stdout: prepareOut.stream,
    stderr: prepareErr.stream,
    async execute({ request }) {
      assert.deepEqual(request, { mode: "prepare", retire: false });
      return {
        mode: "prepare",
        registered: false,
        keyVersion: V2,
        unsafeFutureField: SYNTHETIC_SECRET
      };
    }
  });
  assert.equal(prepareCode, 0);
  assert.equal(prepareErr.value(), "");
  assert.deepEqual(JSON.parse(prepareOut.value()), {
    ok: true,
    mode: "prepare",
    registered: false
  });
  assert.equal(prepareOut.value().includes(V2), false);
  assert.equal(prepareOut.value().includes(SYNTHETIC_SECRET), false);

  const successOut = captureStream();
  const successErr = captureStream();
  const exitCode = await runVaultRotationCli({
    argv: ["rotate", "--retire-previous"],
    env: {},
    stdout: successOut.stream,
    stderr: successErr.stream,
    async execute({ request }) {
      assert.deepEqual(request, { mode: "rotate", retire: true });
      return {
        mode: "rotate",
        credentials: 3,
        changed: 3,
        pendingAfter: 0,
        retired: true,
        unsafeFutureField: SYNTHETIC_SECRET
      };
    }
  });
  assert.equal(exitCode, 0);
  assert.equal(successErr.value(), "");
  assert.deepEqual(JSON.parse(successOut.value()), {
    ok: true,
    mode: "rotate",
    credentials: 3,
    changed: 3,
    pendingAfter: 0,
    retired: true
  });
  assert.equal(successOut.value().includes(SYNTHETIC_SECRET), false);

  const failureOut = captureStream();
  const failureErr = captureStream();
  const failureCode = await runVaultRotationCli({
    argv: ["inventory"],
    env: {},
    stdout: failureOut.stream,
    stderr: failureErr.stream,
    async execute() {
      const error = new Error(SYNTHETIC_SECRET);
      error.code = "synthetic_failure";
      throw error;
    }
  });
  assert.equal(failureCode, 1);
  assert.equal(failureOut.value(), "");
  assert.deepEqual(JSON.parse(failureErr.value()), {
    ok: false,
    code: "vault_rotation_failed"
  });
  assert.equal(failureErr.value().includes(SYNTHETIC_SECRET), false);
});
