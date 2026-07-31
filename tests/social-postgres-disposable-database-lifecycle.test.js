"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");
const {
  CREATE_APPROVAL_PREFIX,
  DISPOSABLE_DATABASE_NAME,
  DROP_APPROVAL_PREFIX,
  assertDisposableLifecycleMarker,
  createDisposableDatabase,
  disposableDatabaseLifecycleMarker,
  disposableDatabaseTargetFingerprint,
  dropDisposableDatabase,
  loadDisposableDatabaseLifecycleConfig
} = require(
  "../src/persistence/postgres/disposable-database-lifecycle"
);
const {
  closePoolsConfirmed,
  main
} = require("../scripts/social-db-disposable-lifecycle");
const {
  completePhysicalEvidence,
  startPhysicalEvidence
} = require("../src/persistence/postgres/physical-gate-evidence");

const PASSWORD =
  "Synthetic-Disposable-Provisioner-Password-2026!";
const EVIDENCE_RUN_ID = "12345678-1234-4abc-8def-1234567890ab";
const EVIDENCE_COMMIT = "a".repeat(40);
const EVIDENCE_STARTED_AT = "2026-07-31T10:00:00.000Z";
const EVIDENCE_COMPLETED_AT = "2026-07-31T10:00:01.000Z";
const EXECUTION_IDENTITY = Object.freeze({
  runId: EVIDENCE_RUN_ID,
  commit: EVIDENCE_COMMIT,
  renderCommitVerified: true,
  codeManifestSha256: "b".repeat(64),
  codeManifestFileCount: 42,
  environment: "staging",
  environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
  region: "oregon"
});

function provisionerUrl(overrides = {}) {
  const target = {
    host: PAID_STAGING_PUBLIC_TARGET.host,
    port: PAID_STAGING_PUBLIC_TARGET.port,
    database: PAID_STAGING_PUBLIC_TARGET.database,
    login: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    sslmode: "verify-full",
    ...overrides
  };
  return (
    `postgresql://${target.login}:${PASSWORD}@` +
    `${target.host}:${target.port}/${target.database}` +
    `?sslmode=${target.sslmode}`
  );
}

function environment(action = "create", overrides = {}) {
  const fingerprint = disposableDatabaseTargetFingerprint();
  const prefix =
    action === "create" ? CREATE_APPROVAL_PREFIX : DROP_APPROVAL_PREFIX;
  return {
    SOCIAL_STAGING_DISPOSABLE_DATABASE_ACTION: action,
    SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED:
      `${prefix}${PAID_STAGING_PUBLIC_TARGET.environmentId}:` +
      fingerprint,
    SOCIAL_STAGING_DISPOSABLE_PROVISIONER_DATABASE_URL:
      provisionerUrl(),
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_ENVIRONMENT_ID:
      PAID_STAGING_PUBLIC_TARGET.environmentId,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_HOST:
      PAID_STAGING_PUBLIC_TARGET.host,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_PORT:
      PAID_STAGING_PUBLIC_TARGET.port,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_PARENT_DATABASE:
      PAID_STAGING_PUBLIC_TARGET.database,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_DATABASE:
      DISPOSABLE_DATABASE_NAME,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_PROVISIONER_LOGIN:
      PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_TARGET_FINGERPRINT:
      fingerprint,
    SOCIAL_2B_EVIDENCE_RUN_ID: EVIDENCE_RUN_ID,
    SOCIAL_2B_EVIDENCE_COMMIT: EVIDENCE_COMMIT,
    RENDER_GIT_COMMIT: EVIDENCE_COMMIT,
    ...overrides
  };
}

function physicalEvidenceHarness({
  sequence = 2,
  databasePurpose = "disposable-gate",
  databaseName = DISPOSABLE_DATABASE_NAME,
  targetFingerprint = disposableDatabaseTargetFingerprint()
} = {}) {
  let startCalls = 0;
  let completeCalls = 0;
  return Object.freeze({
    options: Object.freeze({
      loadIdentity(env) {
        assert.equal(env.SOCIAL_2B_EVIDENCE_RUN_ID, EVIDENCE_RUN_ID);
        assert.equal(env.SOCIAL_2B_EVIDENCE_COMMIT, EVIDENCE_COMMIT);
        assert.equal(env.RENDER_GIT_COMMIT, EVIDENCE_COMMIT);
        return EXECUTION_IDENTITY;
      },
      startEvidence(input) {
        startCalls += 1;
        assert.equal(typeof input.now, "function");
        const { now, ...identity } = input;
        assert.deepEqual(identity, {
          identity: EXECUTION_IDENTITY,
          sequence,
          databasePurpose,
          databaseName,
          targetFingerprint
        });
        return startPhysicalEvidence({
          ...identity,
          now: () => new Date(EVIDENCE_STARTED_AT)
        });
      },
      completeEvidence(started, now) {
        completeCalls += 1;
        assert.equal(typeof now, "function");
        assert.equal(started.runId, EVIDENCE_RUN_ID);
        assert.equal(started.commit, EVIDENCE_COMMIT);
        assert.equal(started.startedAt, EVIDENCE_STARTED_AT);
        return completePhysicalEvidence(
          started,
          () => new Date(EVIDENCE_COMPLETED_AT),
          {
            manifestLoader: () => ({
              sha256: EXECUTION_IDENTITY.codeManifestSha256,
              fileCount: EXECUTION_IDENTITY.codeManifestFileCount
            })
          }
        );
      }
    }),
    expected: Object.freeze({
      ...EXECUTION_IDENTITY,
      sequence,
      databasePurpose,
      databaseName,
      targetFingerprint,
      startedAt: EVIDENCE_STARTED_AT,
      completedAt: EVIDENCE_COMPLETED_AT
    }),
    get startCalls() {
      return startCalls;
    },
    get completeCalls() {
      return completeCalls;
    }
  });
}

function identityRow(database, overrides = {}) {
  return {
    database_name: database,
    current_user_name: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    session_user_name: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    version_num: 180001,
    read_only: "off",
    datistemplate: false,
    datallowconn: true,
    database_owner: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    provisioner_canlogin: true,
    provisioner_superuser: false,
    provisioner_createdb: true,
    provisioner_createrole: true,
    provisioner_replication: false,
    provisioner_bypassrls: false,
    ...overrides
  };
}

function catalogRow(overrides = {}) {
  return {
    database_name: DISPOSABLE_DATABASE_NAME,
    database_owner: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    database_encoding: "UTF8",
    datistemplate: false,
    datallowconn: true,
    lifecycle_marker: disposableDatabaseLifecycleMarker(),
    ...overrides
  };
}

function fakeLifecycle(options = {}) {
  let exists = options.exists === true;
  const parentQueries = [];
  const disposableQueries = [];
  let parentReleased = false;
  let disposableReleased = false;
  let disposablePoolEnded = false;
  const parentClient = {
    async query(text, values) {
      const sql = String(text);
      parentQueries.push({ sql, values });
      if (sql.includes("server_version_num")) {
        return {
          rowCount: 1,
          rows: [
            identityRow(
              PAID_STAGING_PUBLIC_TARGET.database,
              options.parentIdentity
            )
          ]
        };
      }
      if (
        sql.includes("pg_encoding_to_char") &&
        sql.includes("WHERE database_info.datname = $1")
      ) {
        assert.deepEqual(values, [DISPOSABLE_DATABASE_NAME]);
        if (!exists) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [catalogRow(options.catalogIdentity)]
        };
      }
      if (sql.startsWith("CREATE DATABASE")) {
        if (options.createFailure) throw options.createFailure;
        exists = true;
        return { rowCount: null, rows: [] };
      }
      if (sql.startsWith("COMMENT ON DATABASE")) {
        return { rowCount: null, rows: [] };
      }
      if (sql.includes("pg_terminate_backend")) {
        assert.deepEqual(values, [DISPOSABLE_DATABASE_NAME]);
        return {
          rowCount: (options.terminationRows || []).length,
          rows: options.terminationRows || []
        };
      }
      if (sql.startsWith("DROP DATABASE")) {
        if (options.dropFailure) throw options.dropFailure;
        exists = false;
        return { rowCount: null, rows: [] };
      }
      throw new Error("unexpected_parent_query");
    },
    release() {
      parentReleased = true;
    }
  };
  const disposableClient = {
    async query(text) {
      const sql = String(text);
      disposableQueries.push({ sql });
      if (sql.includes("server_version_num")) {
        return {
          rowCount: 1,
          rows: [
            identityRow(
              DISPOSABLE_DATABASE_NAME,
              options.disposableIdentity
            )
          ]
        };
      }
      throw new Error("unexpected_disposable_query");
    },
    release() {
      disposableReleased = true;
    }
  };
  return {
    parentPool: {
      async connect() {
        if (options.parentConnectFailure) {
          throw options.parentConnectFailure;
        }
        return parentClient;
      }
    },
    disposablePool: {
      async connect() {
        if (options.disposableConnectFailure) {
          throw options.disposableConnectFailure;
        }
        return disposableClient;
      },
      async end() {
        if (options.disposablePoolEndFailure) {
          throw options.disposablePoolEndFailure;
        }
        disposablePoolEnded = true;
      }
    },
    parentQueries,
    disposableQueries,
    get parentReleased() {
      return parentReleased;
    },
    get disposableReleased() {
      return disposableReleased;
    },
    get disposablePoolEnded() {
      return disposablePoolEnded;
    },
    get exists() {
      return exists;
    }
  };
}

test("configuration is pinned to one parent and one disposable target", () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  assert.equal(config.action, "create");
  assert.deepEqual(config.target, {
    environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
    host: PAID_STAGING_PUBLIC_TARGET.host,
    port: PAID_STAGING_PUBLIC_TARGET.port,
    parentDatabase: PAID_STAGING_PUBLIC_TARGET.database,
    disposableDatabase: DISPOSABLE_DATABASE_NAME,
    provisionerLogin: PAID_STAGING_PUBLIC_TARGET.provisionerLogin
  });
  assert.equal(config.parentPool.max, 1);
  assert.equal(config.disposablePool.max, 1);
  assert.equal(config.parentPool.ssl.rejectUnauthorized, true);
  assert.equal(config.parentPool.ssl.minVersion, "TLSv1.2");
  assert.equal(
    Object.prototype.hasOwnProperty.call(config.parentPool.ssl, "ca"),
    false
  );
  assert.equal(
    config.parentPool.ssl.servername,
    PAID_STAGING_PUBLIC_TARGET.host
  );
  assert.equal(
    new URL(config.parentPool.connectionString).search,
    ""
  );
  assert.equal(
    new URL(config.disposablePool.connectionString).pathname,
    `/${DISPOSABLE_DATABASE_NAME}`
  );
  assert.equal(JSON.stringify(config).includes(PASSWORD), false);
  assert.equal(
    config.targetFingerprint,
    disposableDatabaseTargetFingerprint()
  );
});

test("create and drop require distinct exact fingerprint-bound approvals", () => {
  assert.doesNotThrow(() =>
    loadDisposableDatabaseLifecycleConfig(environment("create"))
  );
  assert.doesNotThrow(() =>
    loadDisposableDatabaseLifecycleConfig(environment("drop"))
  );
  assert.throws(
    () =>
      loadDisposableDatabaseLifecycleConfig(
        environment("create", {
          SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED:
            environment("drop")
              .SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED
        })
      ),
    { code: "staging_disposable_approval_invalid" }
  );
  assert.throws(
    () =>
      loadDisposableDatabaseLifecycleConfig(
        environment("drop", {
          SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED:
            environment("create")
              .SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED
        })
      ),
    { code: "staging_disposable_approval_invalid" }
  );
});

test("configuration refuses drift, weak TLS and ambient PG inputs", () => {
  const alternateEnvironment =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const overrides of [
    { SOCIAL_STAGING_DISPOSABLE_DATABASE_ACTION: "CREATE" },
    {
      SOCIAL_STAGING_DISPOSABLE_EXPECTED_ENVIRONMENT_ID:
        alternateEnvironment
    },
    {
      SOCIAL_STAGING_DISPOSABLE_EXPECTED_HOST:
        "dpg-other-a.oregon-postgres.render.com"
    },
    {
      SOCIAL_STAGING_DISPOSABLE_EXPECTED_PARENT_DATABASE:
        "ia4tube_social_other"
    },
    {
      SOCIAL_STAGING_DISPOSABLE_EXPECTED_DATABASE:
        "ia4tube_social_staging_disposable_other"
    },
    {
      SOCIAL_STAGING_DISPOSABLE_EXPECTED_TARGET_FINGERPRINT:
        "0".repeat(64)
    },
    {
      SOCIAL_STAGING_DISPOSABLE_EXPECTED_TARGET_FINGERPRINT:
        disposableDatabaseTargetFingerprint().toUpperCase()
    },
    {
      SOCIAL_STAGING_DISPOSABLE_EXPECTED_PROVISIONER_LOGIN:
        PAID_STAGING_PUBLIC_TARGET.provisionerLogin.toUpperCase()
    },
    {
      SOCIAL_STAGING_DISPOSABLE_PROVISIONER_DATABASE_URL:
        provisionerUrl({
          host: "dpg-other-a.oregon-postgres.render.com"
        })
    },
    {
      SOCIAL_STAGING_DISPOSABLE_PROVISIONER_DATABASE_URL:
        provisionerUrl({
          login:
            PAID_STAGING_PUBLIC_TARGET.provisionerLogin.toUpperCase()
        })
    },
    {
      SOCIAL_STAGING_DISPOSABLE_PROVISIONER_DATABASE_URL:
        provisionerUrl({ sslmode: "require" })
    },
    {
      SOCIAL_STAGING_DISPOSABLE_PROVISIONER_DATABASE_URL:
        `${provisionerUrl()}&application_name=forbidden`
    },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { PGPASSWORD: "ambient-secret" }
  ]) {
    assert.throws(
      () =>
        loadDisposableDatabaseLifecycleConfig(
          environment("create", overrides)
        ),
      (error) =>
        String(error?.code || "").startsWith(
          "staging_disposable_"
        ) &&
        !String(error?.message || "").includes(PASSWORD)
    );
  }
});

test("create proves exact absence, uses template0 and verifies identity", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  const fake = fakeLifecycle({ exists: false });
  const result = await createDisposableDatabase(
    fake.parentPool,
    fake.disposablePool,
    config
  );
  assert.deepEqual(result, {
    safe: true,
    created: true,
    identityVerified: true
  });
  assert.equal(fake.exists, true);
  const mutation = fake.parentQueries.filter(
    ({ sql }) =>
      /^(?:CREATE|COMMENT|DROP|BEGIN|COMMIT|ROLLBACK)/.test(sql)
  );
  assert.equal(mutation.length, 2);
  assert.match(
    mutation[0].sql,
    new RegExp(
      `^CREATE DATABASE "${DISPOSABLE_DATABASE_NAME}" ` +
        `WITH OWNER = "` +
        `${PAID_STAGING_PUBLIC_TARGET.provisionerLogin}" ` +
        "TEMPLATE = template0 ENCODING = 'UTF8'$"
    )
  );
  assert.equal(
    mutation[1].sql,
    `COMMENT ON DATABASE "${DISPOSABLE_DATABASE_NAME}" IS '` +
      `${disposableDatabaseLifecycleMarker()}'`
  );
  assert.equal(fake.parentReleased, true);
  assert.equal(fake.disposableReleased, true);
});

test("create refuses an existing target and every unsafe provisioner shape", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  const existing = fakeLifecycle({ exists: true });
  await assert.rejects(
    createDisposableDatabase(
      existing.parentPool,
      existing.disposablePool,
      config
    ),
    { code: "staging_disposable_create_target_exists" }
  );
  assert.equal(
    existing.parentQueries.some(({ sql }) =>
      sql.startsWith("CREATE DATABASE")
    ),
    false
  );

  for (const parentIdentity of [
    { database_name: DISPOSABLE_DATABASE_NAME },
    { database_owner: "other_owner" },
    { version_num: 170999 },
    { version_num: 190000 },
    { provisioner_superuser: true },
    { provisioner_createdb: false },
    { provisioner_createrole: false },
    { provisioner_replication: true },
    { provisioner_bypassrls: true }
  ]) {
    const unsafe = fakeLifecycle({
      exists: false,
      parentIdentity
    });
    await assert.rejects(
      createDisposableDatabase(
        unsafe.parentPool,
        unsafe.disposablePool,
        config
      ),
      { code: "staging_disposable_database_identity_invalid" }
    );
    assert.equal(
      unsafe.parentQueries.some(({ sql }) =>
        sql.startsWith("CREATE DATABASE")
      ),
      false
    );
  }
});

test("post-create verification fails closed without automatic deletion", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  const fake = fakeLifecycle({
    exists: false,
    disposableIdentity: { database_owner: "unexpected_owner" }
  });
  await assert.rejects(
    createDisposableDatabase(
      fake.parentPool,
      fake.disposablePool,
      config
    ),
    { code: "staging_disposable_database_identity_invalid" }
  );
  assert.equal(fake.exists, true);
  assert.equal(
    fake.parentQueries.some(({ sql }) =>
      sql.startsWith("DROP DATABASE")
    ),
    false
  );
});

test("drop verifies identity, terminates only exact sessions and confirms absence", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("drop"));
  const fake = fakeLifecycle({
    exists: true,
    terminationRows: [{ terminated: true }, { terminated: true }]
  });
  const result = await dropDisposableDatabase(
    fake.parentPool,
    fake.disposablePool,
    config
  );
  assert.deepEqual(result, {
    safe: true,
    dropped: true,
    identityVerified: true,
    sessionsTerminated: true,
    absenceConfirmed: true,
    disposablePoolClosed: true
  });
  assert.equal(fake.disposablePoolEnded, true);
  assert.equal(fake.exists, false);
  const terminate = fake.parentQueries.find(({ sql }) =>
    sql.includes("pg_terminate_backend")
  );
  assert.deepEqual(terminate.values, [DISPOSABLE_DATABASE_NAME]);
  assert.match(terminate.sql, /WHERE activity\.datname = \$1/);
  assert.match(terminate.sql, /activity\.pid <>/);
  const drop = fake.parentQueries.find(({ sql }) =>
    sql.startsWith("DROP DATABASE")
  );
  assert.equal(
    drop.sql,
    `DROP DATABASE "${DISPOSABLE_DATABASE_NAME}" WITH (FORCE)`
  );
  assert.equal(
    fake.parentQueries.some(({ sql }) =>
      /BEGIN|COMMIT|ROLLBACK/.test(sql)
    ),
    false
  );
});

test("drop closes the disposable pool before terminating any session", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("drop"));
  const fake = fakeLifecycle({
    exists: true,
    disposablePoolEndFailure: new Error(`close-${PASSWORD}`)
  });
  await assert.rejects(
    dropDisposableDatabase(
      fake.parentPool,
      fake.disposablePool,
      config
    ),
    (error) =>
      error?.code === "staging_disposable_pool_close_failed" &&
      !String(error?.message || "").includes(PASSWORD)
  );
  assert.equal(
    fake.parentQueries.some(({ sql }) =>
      sql.includes("pg_terminate_backend")
    ),
    false
  );
  assert.equal(
    fake.parentQueries.some(({ sql }) =>
      sql.startsWith("DROP DATABASE")
    ),
    false
  );
  assert.equal(fake.exists, true);
});

test("drop refuses absence, catalog drift and failed termination", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("drop"));
  const absent = fakeLifecycle({ exists: false });
  await assert.rejects(
    dropDisposableDatabase(
      absent.parentPool,
      absent.disposablePool,
      config
    ),
    { code: "staging_disposable_drop_target_absent" }
  );

  const drifted = fakeLifecycle({
    exists: true,
    catalogIdentity: { database_owner: "other_owner" }
  });
  await assert.rejects(
    dropDisposableDatabase(
      drifted.parentPool,
      drifted.disposablePool,
      config
    ),
    { code: "staging_disposable_catalog_identity_invalid" }
  );

  const terminationFailure = fakeLifecycle({
    exists: true,
    terminationRows: [{ terminated: false }]
  });
  await assert.rejects(
    dropDisposableDatabase(
      terminationFailure.parentPool,
      terminationFailure.disposablePool,
      config
    ),
    { code: "staging_disposable_session_termination_failed" }
  );
  assert.equal(terminationFailure.exists, true);
  assert.equal(
    terminationFailure.parentQueries.some(({ sql }) =>
      sql.startsWith("DROP DATABASE")
    ),
    false
  );

  const unmarked = fakeLifecycle({
    exists: true,
    catalogIdentity: { lifecycle_marker: null }
  });
  await assert.rejects(
    dropDisposableDatabase(
      unmarked.parentPool,
      unmarked.disposablePool,
      config
    ),
    { code: "staging_disposable_lifecycle_marker_mismatch" }
  );
  assert.equal(
    unmarked.parentQueries.some(({ sql }) =>
      sql.includes("pg_terminate_backend")
    ),
    false
  );
});

test("lifecycle marker is exact and fingerprint-bound", () => {
  assert.match(
    disposableDatabaseLifecycleMarker(),
    /^ia4tube-social-staging-disposable-lifecycle-v1:[0-9a-f]{64}$/
  );
  assert.equal(
    assertDisposableLifecycleMarker(catalogRow()),
    true
  );
  assert.throws(
    () =>
      assertDisposableLifecycleMarker(
        catalogRow({ lifecycle_marker: "other" })
      ),
    { code: "staging_disposable_lifecycle_marker_mismatch" }
  );
});

test("driver failures are reduced to safe codes without secret output", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  const fake = fakeLifecycle({
    parentConnectFailure: new Error(`driver-${PASSWORD}`)
  });
  await assert.rejects(
    createDisposableDatabase(
      fake.parentPool,
      fake.disposablePool,
      config
    ),
    (error) =>
      error.code === "staging_disposable_create_failed" &&
      !error.message.includes(PASSWORD)
  );

  let stdout = "";
  let stderr = "";
  class FailingPool {
    constructor() {}
    async connect() {
      throw new Error(`driver-${PASSWORD}`);
    }
    async end() {}
  }
  const physical = physicalEvidenceHarness();
  const status = await main({
    env: environment("create"),
    argv: [],
    PoolClass: FailingPool,
    ...physical.options,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.equal(stderr.includes(PASSWORD), false);
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: "staging_disposable_create_failed"
  });
  assert.equal(physical.startCalls, 1);
  assert.equal(physical.completeCalls, 0);
});

test("operator success output binds physical evidence and closes both pools", async () => {
  const fake = fakeLifecycle({ exists: false });
  let constructed = 0;
  let ended = 0;
  const receivedConnections = [];
  class FakePool {
    constructor(options) {
      constructed += 1;
      receivedConnections.push(options.connectionString);
      this.delegate =
        options.application_name ===
        "ia4tube-social-disposable-parent"
          ? fake.parentPool
          : fake.disposablePool;
    }
    async connect() {
      return this.delegate.connect();
    }
    async end() {
      ended += 1;
    }
  }
  let stdout = "";
  let stderr = "";
  const physical = physicalEvidenceHarness();
  const status = await main({
    env: environment("create"),
    argv: [],
    PoolClass: FakePool,
    ...physical.options,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.equal(stdout.includes(PASSWORD), false);
  const evidence = JSON.parse(stdout);
  assert.equal(constructed, 2);
  assert.equal(ended, 2);
  assert.equal(
    receivedConnections.every((value) => typeof value === "string"),
    true
  );
  assert.deepEqual(
    receivedConnections.map(
      (value) => decodeURIComponent(new URL(value).pathname.slice(1))
    ),
    [
      PAID_STAGING_PUBLIC_TARGET.database,
      DISPOSABLE_DATABASE_NAME
    ]
  );
  assert.deepEqual(evidence, {
    ok: true,
    safe: true,
    created: true,
    dropped: false,
    identityVerified: true,
    sessionsTerminated: false,
    absenceConfirmed: false,
    ...physical.expected
  });
  assert.equal(physical.startCalls, 1);
  assert.equal(physical.completeCalls, 1);
});

test("operator refuses success unless both pools close cleanly", async () => {
  const secret = PASSWORD;
  await assert.rejects(
    closePoolsConfirmed([
      { async end() {} },
      {
        async end() {
          throw new Error(`close-${secret}`);
        }
      }
    ]),
    (error) =>
      error?.code === "staging_disposable_pool_close_failed" &&
      !String(error?.message || "").includes(secret)
  );

  for (const failingIndex of [0, 1]) {
    const fake = fakeLifecycle({ exists: false });
    let constructed = 0;
    let stdout = "";
    let stderr = "";
    class CloseFailurePool {
      constructor(options) {
        this.index = constructed;
        constructed += 1;
        this.delegate =
          options.application_name ===
          "ia4tube-social-disposable-parent"
            ? fake.parentPool
            : fake.disposablePool;
      }
      async connect() {
        return this.delegate.connect();
      }
      async end() {
        if (this.index === failingIndex) {
          throw new Error(`close-${PASSWORD}`);
        }
      }
    }
    const physical = physicalEvidenceHarness();
    const status = await main({
      env: environment("create"),
      PoolClass: CloseFailurePool,
      ...physical.options,
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } }
    });
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.equal(stderr.includes(PASSWORD), false);
    assert.deepEqual(JSON.parse(stderr), {
      ok: false,
      code: "staging_disposable_pool_close_failed"
    });
    assert.equal(physical.startCalls, 1);
    assert.equal(physical.completeCalls, 0);
  }
});

test("operator refuses argv before loading credentials or creating pools", async () => {
  let constructed = 0;
  let identityLoads = 0;
  class ForbiddenPool {
    constructor() {
      constructed += 1;
    }
  }
  let stderr = "";
  const status = await main({
    env: environment("create"),
    argv: ["--database-url", provisionerUrl()],
    PoolClass: ForbiddenPool,
    loadIdentity() {
      identityLoads += 1;
      return EXECUTION_IDENTITY;
    },
    stdout: { write() {} },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 2);
  assert.equal(constructed, 0);
  assert.equal(identityLoads, 0);
  assert.equal(stderr.includes(PASSWORD), false);
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: "staging_disposable_argv_refused"
  });
});
