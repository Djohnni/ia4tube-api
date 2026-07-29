"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  assertWebServiceDatabaseCredentialBoundary,
  databaseTargetFingerprint,
  loadMigrationPostgresConfig,
  loadRuntimePostgresConfig
} = require("../src/persistence/postgres/config");
const {
  MIGRATION_CONNECTION_LIMIT
} = require("../src/persistence/postgres/login-bootstrap");
const { createSocialRuntime } = require("../src/social/runtime");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");

const environmentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const namespace = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const root = path.resolve(__dirname, "..");

function key(byte) {
  return Buffer.alloc(32, byte);
}

function vaultEnvironment(secondKey = key(3)) {
  const firstKey = key(2);
  const activeVersion = deriveVaultKeyVersion(1, firstKey);
  const secondVersion = deriveVaultKeyVersion(2, secondKey);
  return {
    activeVersion,
    fingerprint: vaultKeyringFingerprint(activeVersion, [
      activeVersion,
      secondVersion
    ]),
    keysJson: JSON.stringify({
      [activeVersion]: firstKey.toString("base64"),
      [secondVersion]: secondKey.toString("base64")
    })
  };
}

function targetOf(url) {
  return databaseTargetFingerprint(new URL(url));
}

function migrationEnv(overrides = {}) {
  const migrationUrl =
    "postgresql://ia4tube_social_migrator:" +
    "migration-password@LOCALHOST/social_test";
  return {
    NODE_ENV: "test",
    SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST: "true",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
    SOCIAL_MIGRATIONS_DATABASE_URL: migrationUrl,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(migrationUrl),
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "ia4tube_social_migrator",
    SOCIAL_MIGRATION_ENVIRONMENT: "test",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: environmentId,
    ...overrides
  };
}

function socialRuntimeEnv(overrides = {}) {
  const runtimeUrl =
    "postgresql://ia4tube_social_runtime:" +
    "runtime-password@localhost/social_test";
  const vault = vaultEnvironment();
  return {
    NODE_ENV: "test",
    SOCIAL_PERSISTENCE_ENABLED: "true",
    SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST: "true",
    DATABASE_URL: runtimeUrl,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(runtimeUrl),
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
    SOCIAL_IDENTITY_DERIVATION_KEY: key(1).toString("base64"),
    SOCIAL_TENANT_NAMESPACE_UUID: namespace,
    SOCIAL_IDENTITY_DERIVATION_VERSION: "identity-v1",
    SOCIAL_VAULT_ACTIVE_KEY_VERSION: vault.activeVersion,
    SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT: vault.fingerprint,
    SOCIAL_VAULT_KEYS_JSON: vault.keysJson,
    JWT_SECRET: "independent-jwt-secret-material-for-this-synthetic-test",
    ORDER_MEDIA_SIGNING_SECRET:
      "independent-order-signing-material-for-this-synthetic-test",
    ...overrides
  };
}

test("runtime and migration pool budgets are bounded for a 512 MB service", () => {
  const runtime = loadRuntimePostgresConfig({
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL:
      "postgresql://ia4tube_social_runtime:password@db.example.test/social",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
      "postgresql://ia4tube_social_runtime:" +
        "password@db.example.test/social"
    )
  });
  assert.equal(runtime.pool.max, 3);
  assert.match(runtime.pool.options, /-c lock_timeout=5000(?:\s|$)/);

  const tuned = loadRuntimePostgresConfig({
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL:
      "postgresql://ia4tube_social_runtime:password@db.example.test/social",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
      "postgresql://ia4tube_social_runtime:" +
        "password@db.example.test/social"
    ),
    SOCIAL_DATABASE_POOL_MAX: "5",
    SOCIAL_DATABASE_LOCK_TIMEOUT_MS: "750"
  });
  assert.equal(tuned.pool.max, 5);
  assert.match(tuned.pool.options, /-c lock_timeout=750(?:\s|$)/);

  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        SOCIAL_PERSISTENCE_ENABLED: "true",
        DATABASE_URL:
          "postgresql://ia4tube_social_runtime:password@db.example.test/social",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
          "postgresql://ia4tube_social_runtime:" +
            "password@db.example.test/social"
        ),
        SOCIAL_DATABASE_POOL_MAX: "6"
      }),
    { code: "social_database_pool_max_invalid" }
  );
  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        SOCIAL_PERSISTENCE_ENABLED: "true",
        DATABASE_URL:
          "postgresql://ia4tube_social_runtime:password@db.example.test/social",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
          "postgresql://ia4tube_social_runtime:" +
            "password@db.example.test/social"
        ),
        SOCIAL_DATABASE_LOCK_TIMEOUT_MS: "10001"
      }),
    { code: "social_database_lock_timeout_invalid" }
  );

  const migration = loadMigrationPostgresConfig(migrationEnv());
  assert.equal(MIGRATION_CONNECTION_LIMIT, 2);
  assert.equal(migration.pool.max, 1);
  assert.match(migration.pool.options, /-c lock_timeout=5000(?:\s|$)/);
  assert.throws(
    () =>
      loadMigrationPostgresConfig(
        migrationEnv({ SOCIAL_MIGRATION_POOL_MAX: "2" })
      ),
    { code: "social_database_pool_max_invalid" }
  );

  const shortStatement = loadRuntimePostgresConfig({
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL:
      "postgresql://ia4tube_social_runtime:password@db.example.test/social",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
      "postgresql://ia4tube_social_runtime:" +
        "password@db.example.test/social"
    ),
    SOCIAL_DATABASE_STATEMENT_TIMEOUT_MS: "1000"
  });
  assert.match(
    shortStatement.pool.options,
    /-c lock_timeout=1000(?:\s|$)/
  );
});

test("migration job accepts only its secret URL plus public runtime identity", () => {
  const config = loadMigrationPostgresConfig(migrationEnv());
  assert.equal(config.target.host, "localhost");
  assert.equal(config.target.port, "5432");
  assert.equal(config.target.database, "social_test");
  assert.equal(config.target.username, "ia4tube_social_migrator");

  for (const DATABASE_URL of [
    "postgresql://ia4tube_social_runtime:password@other.test/social_test",
    "postgresql://ia4tube_social_runtime:password@localhost:6432/social_test",
    "postgresql://ia4tube_social_runtime:password@localhost/other_database"
  ]) {
    assert.throws(
      () => loadMigrationPostgresConfig(migrationEnv({ DATABASE_URL })),
      { code: "migration_runtime_database_credential_forbidden" }
    );
  }

  assert.throws(
    () =>
      loadMigrationPostgresConfig(
        migrationEnv({
          SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:
            "ia4tube_social_migrator"
        })
      ),
    { code: "migration_runtime_credentials_must_differ" }
  );

  const withoutRuntimeIdentity = migrationEnv();
  delete withoutRuntimeIdentity.SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN;
  assert.throws(
    () => loadMigrationPostgresConfig(withoutRuntimeIdentity),
    { code: "social_database_expected_runtime_login_invalid" }
  );
});

test("remote runtime and migration URLs require a password", () => {
  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        SOCIAL_PERSISTENCE_ENABLED: "true",
        DATABASE_URL:
          "postgresql://ia4tube_social_runtime@db.example.test/social",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
          "postgresql://ia4tube_social_runtime@db.example.test/social"
        )
      }),
    { code: "database_url_password_required" }
  );
  assert.throws(
    () =>
      loadMigrationPostgresConfig(
        migrationEnv({
          SOCIAL_MIGRATIONS_DATABASE_URL:
            "postgresql://ia4tube_social_migrator@db.example.test/social"
        })
    ),
    { code: "social_migrations_database_url_password_required" }
  );
});

test("database URLs reject every parameter that could override the approved authority", () => {
  const base =
    "postgresql://ia4tube_social_runtime:password" +
    "@db.example.test/social";
  for (const query of [
    "host=evil.example.test",
    "hostaddr=127.0.0.1",
    "user=ia4tube_social_owner",
    "password=other",
    "port=6432",
    "dbname=other",
    "options=-c%20role%3Dia4tube_social_owner",
    "application_name=untrusted",
    "service=untrusted",
    "sslcert=untrusted",
    "sslkey=untrusted",
    "sslrootcert=untrusted",
    "sslnegotiation=direct",
    "sslmode=verify-full&sslmode=disable"
  ]) {
    assert.throws(
      () =>
        loadRuntimePostgresConfig(
          socialRuntimeEnv({
            DATABASE_URL: `${base}?${query}`,
            SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
              targetOf(base)
          })
        ),
      { code: "social_database_connection_parameter_forbidden" }
    );
  }

  for (const mode of ["disable", "allow", "prefer", "require", "verify-ca"]) {
    assert.throws(
      () =>
        loadRuntimePostgresConfig(
          socialRuntimeEnv({
            DATABASE_URL: `${base}?sslmode=${mode}`,
            SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
              targetOf(base)
          })
        ),
      { code: "social_database_tls_mode_invalid" }
    );
  }

  assert.throws(
    () =>
      loadRuntimePostgresConfig(
        socialRuntimeEnv({
          DATABASE_URL: `${base}#host=evil.example.test`,
          SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
            targetOf(base)
        })
      ),
    { code: "database_url_invalid" }
  );

  const approved = loadRuntimePostgresConfig(
    socialRuntimeEnv({
      DATABASE_URL: `${base}?sslmode=verify-full`,
      SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
        targetOf(base)
    })
  );
  assert.equal(approved.pool.connectionString.includes("?"), false);
  assert.equal(approved.pool.connectionString.includes("#"), false);
});

test("database login identities must already be canonical lowercase", () => {
  assert.throws(
    () =>
      loadRuntimePostgresConfig(
        socialRuntimeEnv({
          DATABASE_URL:
            "postgresql://IA4TUBE_SOCIAL_RUNTIME:password" +
            "@db.example.test/social?sslmode=verify-full",
          SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
            "postgresql://ia4tube_social_runtime:password" +
              "@db.example.test/social"
          )
        })
      ),
    { code: "social_database_login_must_be_canonical" }
  );
  assert.throws(
    () =>
      loadRuntimePostgresConfig(
        socialRuntimeEnv({
          SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:
            "IA4TUBE_SOCIAL_RUNTIME"
        })
      ),
    {
      code:
        "social_database_expected_runtime_login_must_be_canonical"
    }
  );
});

test("database names are one canonical unescaped PostgreSQL label", () => {
  for (const encodedDatabase of [
    "social%2Fevil",
    "social/evil",
    "%73ocial",
    "Social",
    "social-name"
  ]) {
    assert.throws(
      () =>
        loadRuntimePostgresConfig(
          socialRuntimeEnv({
            DATABASE_URL:
              "postgresql://ia4tube_social_runtime:password" +
              `@db.example.test/${encodedDatabase}` +
              "?sslmode=verify-full"
          })
        ),
      { code: "database_url_database_invalid" }
    );
  }
  assert.throws(
    () =>
      targetOf(
        "postgresql://ia4tube_social_runtime:password" +
          "@db.example.test/social%2Fevil"
      ),
    { code: "social_database_target_database_invalid" }
  );
});

test("runtime and migration login identities must match explicit public expectations", () => {
  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        SOCIAL_PERSISTENCE_ENABLED: "true",
        DATABASE_URL:
          "postgresql://runtime_login:password@db.example.test/social",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
          "postgresql://runtime_login:password@db.example.test/social"
        )
      }),
    { code: "social_database_expected_runtime_login_invalid" }
  );
  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        SOCIAL_PERSISTENCE_ENABLED: "true",
        DATABASE_URL:
          "postgresql://runtime_login:password@db.example.test/social",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "other_runtime_login",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
          "postgresql://runtime_login:password@db.example.test/social"
        )
      }),
    { code: "social_database_expected_runtime_login_mismatch" }
  );
  assert.throws(
    () =>
      loadMigrationPostgresConfig(
        migrationEnv({
          SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "other_migration_login"
        })
      ),
    { code: "social_migrations_expected_login_mismatch" }
  );
  assert.throws(
    () =>
      loadMigrationPostgresConfig(
        migrationEnv({
          SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:
            "IA4TUBE_SOCIAL_RUNTIME"
        })
      ),
    {
      code:
        "social_database_expected_runtime_login_must_be_canonical"
    }
  );
});

test("future Web Service boundary rejects migration and provisioner credentials", () => {
  const safe = {
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL:
      "postgresql://ia4tube_social_runtime:password@db.example.test/social",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
      "postgresql://ia4tube_social_runtime:password@db.example.test/social"
    )
  };
  assert.equal(assertWebServiceDatabaseCredentialBoundary(safe), true);

  for (const privileged of [
    {
      SOCIAL_MIGRATIONS_DATABASE_URL:
        "postgresql://ia4tube_social_migrator:password@db.example.test/social"
    },
    {
      SOCIAL_PROVISIONER_DATABASE_URL:
        "postgresql://synthetic_provisioner:password@db.example.test/social"
    },
    {
      SOCIAL_TEST_PROVISIONER_DATABASE_URL:
        "postgresql://synthetic_provisioner:password@db.example.test/social"
    },
    {
      SOCIAL_BACKUP_SOURCE_DATABASE_URL:
        "postgresql://synthetic_migrator:password@db.example.test/social"
    },
    {
      SOCIAL_RESTORE_TARGET_DATABASE_URL:
        "postgresql://synthetic_migrator:password@db.example.test/social"
    },
    {
      SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL:
        "postgresql://synthetic_provisioner:password@db.example.test/social"
    },
    {
      SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL:
        "postgresql://synthetic_provisioner:password@db.example.test/social"
    },
    {
      SOCIAL_LOGIN_BOOTSTRAP_PROVISIONER_DATABASE_URL:
        "postgresql://synthetic_provisioner:password@db.example.test/social"
    },
    {
      SOCIAL_POSTGRES_SIZING_DATABASE_URL:
        "postgresql://synthetic_runtime:password@db.example.test/social"
    },
    {
      SOCIAL_TEST_RUNTIME_DATABASE_URL:
        "postgresql://synthetic_runtime:password@db.example.test/social"
    },
    {
      DATABASE_BACKUP_URL:
        "postgresql://synthetic_migrator:password@db.example.test/social"
    },
    {
      RESTORE_DATABASE_URL:
        "postgresql://synthetic_migrator:password@db.example.test/social"
    },
    {
      SOCIAL_BOOTSTRAP_DB_URL:
        "postgresql://synthetic_provisioner:password@db.example.test/social"
    }
  ]) {
    assert.throws(
      () =>
        assertWebServiceDatabaseCredentialBoundary({
          ...safe,
          ...privileged
        }),
      { code: "web_service_privileged_database_credential_forbidden" }
    );
  }

  for (const name of [
    "SOCIAL_BACKUP_BUNDLE_KEY",
    "SOCIAL_LOGIN_BOOTSTRAP_MIGRATION_PASSWORD",
    "SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD"
  ]) {
    assert.throws(
      () =>
        assertWebServiceDatabaseCredentialBoundary({
          ...safe,
          [name]: "synthetic-operator-secret-never-log"
        }),
      { code: "web_service_operator_secret_forbidden" }
    );
  }

  for (const [name, value] of [
    ["SOCIAL_PROVISIONER_PASSWORD", "synthetic-password"],
    ["SOCIAL_MIGRATION_SECRET", "synthetic-secret"],
    ["SOCIAL_BACKUP_API_TOKEN", "synthetic-token"],
    ["SOCIAL_RESTORE_ENCRYPTION_KEY", "synthetic-key"],
    ["SOCIAL_TEST_SIGNING_KEY", "synthetic-key"],
    ["SOCIAL_OPERATOR_ACCESS_TOKEN", "synthetic-token"]
  ]) {
    assert.throws(
      () =>
        assertWebServiceDatabaseCredentialBoundary({
          ...safe,
          [name]: value
        }),
      { code: "web_service_privileged_operator_secret_forbidden" }
    );
  }

  for (const name of [
    "SOCIAL_VAULT_ROTATION_ACTIVE_KEY_VERSION",
    "SOCIAL_VAULT_ROTATION_APPROVAL",
    "SOCIAL_VAULT_ROTATION_BATCH_SIZE",
    "SOCIAL_VAULT_ROTATION_DATABASE_CA_BASE64",
    "SOCIAL_VAULT_ROTATION_ENVIRONMENT",
    "SOCIAL_VAULT_ROTATION_EXPECTED_CURRENT_KEY_VERSION",
    "SOCIAL_VAULT_ROTATION_EXPECTED_ENVIRONMENT_ID",
    "SOCIAL_VAULT_ROTATION_EXPECTED_KEYRING_FINGERPRINT",
    "SOCIAL_VAULT_ROTATION_EXPECTED_MIGRATION_LOGIN",
    "SOCIAL_VAULT_ROTATION_EXPECTED_RUNTIME_LOGIN",
    "SOCIAL_VAULT_ROTATION_EXPECTED_TARGET_FINGERPRINT",
    "SOCIAL_VAULT_ROTATION_IDENTITY_DERIVATION_VERSION",
    "SOCIAL_VAULT_ROTATION_KEYS_JSON",
    "SOCIAL_VAULT_ROTATION_MIGRATIONS_DATABASE_URL",
    "SOCIAL_VAULT_ROTATION_PRODUCTION_APPROVAL",
    "SOCIAL_VAULT_ROTATION_RETIRE_KEY_VERSION",
    "SOCIAL_VAULT_ROTATION_RUNTIME_DATABASE_URL"
  ]) {
    assert.throws(
      () =>
        assertWebServiceDatabaseCredentialBoundary({
          ...safe,
          [name]: "synthetic-operator-setting"
        }),
      { code: "web_service_operator_environment_forbidden" }
    );
  }

  assert.equal(
    assertWebServiceDatabaseCredentialBoundary({
      ...safe,
      SOCIAL_BACKUP_EXPECTED_ENVIRONMENT: "synthetic",
      SOCIAL_RESTORE_EXPECTED_RUNTIME_LOGIN: "synthetic_runtime",
      SOCIAL_POSTGRES_SIZING_EXPECTED_TARGET_FINGERPRINT:
        "a".repeat(64),
      SOCIAL_TEST_ENVIRONMENT_ID: environmentId,
      SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: environmentId,
      SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_TARGET_FINGERPRINT:
        "b".repeat(64),
      SOCIAL_BACKUP_PG_DUMP_PATH: "/synthetic/pg_dump"
    }),
    true
  );

  assert.equal(
    assertWebServiceDatabaseCredentialBoundary({
      ...safe,
      SOCIAL_VAULT_KEYS_JSON: JSON.stringify({
        active: "synthetic-runtime-key-reference"
      })
    }),
    true
  );

  assert.throws(
    () =>
      assertWebServiceDatabaseCredentialBoundary({
        ...safe,
        DATABASE_URL:
          "postgresql://ia4tube_social_migrator:password@db.example.test/social",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:
          "ia4tube_social_runtime_login"
      }),
    { code: "social_database_expected_runtime_login_mismatch" }
  );
});

test("Web Service boundary refuses libpq ambient connection overrides", () => {
  const safe = socialRuntimeEnv();
  for (const name of [
    "PGPASSWORD",
    "PGPASSFILE",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGUSER",
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGDATABASE",
    "PGSSLMODE",
    "PGSSLKEY",
    "PGSSLCERT",
    "PGSSLCERTMODE",
    "PGSSLCOMPRESSION",
    "PGSSLROOTCERT",
    "PGOPTIONS",
    "PGAPPNAME",
    "PGCHANNELBINDING",
    "PGCONNECT_TIMEOUT",
    "PGGSSDELEGATION",
    "PGMINPROTOCOLVERSION",
    "PGMAXPROTOCOLVERSION",
    "PGREQUIREAUTH",
    "PGTARGETSESSIONATTRS",
    "PGDATESTYLE",
    "PGTZ",
    "PGGEQO",
    "PGLOCALEDIR",
    "PGREPLICATION",
    "PGBINARY",
    "PGCLIENT_ENCODING",
    "PG_FUTURE_OVERRIDE"
  ]) {
    assert.throws(
      () =>
        assertWebServiceDatabaseCredentialBoundary({
          ...safe,
          [name]: "synthetic-libpq-override"
        }),
      { code: "web_service_libpq_environment_override_forbidden" }
    );
  }

  assert.equal(
    assertWebServiceDatabaseCredentialBoundary({
      ...safe,
      PGPASSWORD: " "
    }),
    true
  );
});

test("Web Service boundary reuses all runtime credential semantics", () => {
  const safe = socialRuntimeEnv();
  assert.equal(assertWebServiceDatabaseCredentialBoundary(safe), true);

  assert.throws(
    () =>
      assertWebServiceDatabaseCredentialBoundary({
        ...safe,
        DATABASE_URL:
          "postgresql://ia4tube_social_runtime@db.example.test/social",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
          "postgresql://ia4tube_social_runtime@db.example.test/social"
        )
      }),
    { code: "database_url_password_required" }
  );
  assert.throws(
    () =>
      assertWebServiceDatabaseCredentialBoundary({
        ...safe,
        DATABASE_URL:
          "postgresql://ia4tube_social_runtime:password@" +
          "db.example.test/social?sslmode=disable",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
          "postgresql://ia4tube_social_runtime:password@" +
            "db.example.test/social?sslmode=disable"
        )
      }),
    { code: "social_database_tls_mode_invalid" }
  );
  assert.throws(
    () =>
      assertWebServiceDatabaseCredentialBoundary({
        ...safe,
        SOCIAL_DATABASE_RUNTIME_ROLE: "synthetic_runtime_role"
      }),
    { code: "social_database_runtime_role_must_be_canonical" }
  );
  assert.throws(
    () =>
      assertWebServiceDatabaseCredentialBoundary({
        ...safe,
        SOCIAL_DATABASE_POOL_MAX: "6"
      }),
    { code: "social_database_pool_max_invalid" }
  );
});

test("runtime and migration require the same explicit public database target fingerprint", () => {
  const runtimeUrl =
    "postgresql://ia4tube_social_runtime:password@db.example.test/social";
  const migrationUrl =
    "postgresql://ia4tube_social_migrator:other-password@" +
    "db.example.test/social";
  const expected = targetOf(runtimeUrl);

  assert.equal(targetOf(migrationUrl), expected);
  assert.equal(
    targetOf(
      "postgresql://another-user:another-secret@DB.EXAMPLE.TEST:5432/social"
    ),
    expected
  );
  assert.notEqual(
    targetOf(
      "postgresql://another-user:another-secret@db.example.test:6432/social"
    ),
    expected
  );
  assert.notEqual(
    targetOf(
      "postgresql://another-user:another-secret@db.example.test/other"
    ),
    expected
  );

  for (const fingerprint of [
    undefined,
    "0".repeat(64),
    ` ${expected}`,
    `${expected} `
  ]) {
    assert.throws(
      () =>
        loadRuntimePostgresConfig({
          ...socialRuntimeEnv(),
          SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: fingerprint
        }),
      {
        code:
          "social_database_expected_target_fingerprint_mismatch"
      }
    );
    assert.throws(
      () =>
        loadMigrationPostgresConfig(
          migrationEnv({
            SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: fingerprint
          })
        ),
      {
        code:
          "social_database_expected_target_fingerprint_mismatch"
      }
    );
  }

  const runtime = loadRuntimePostgresConfig(
    socialRuntimeEnv({
      DATABASE_URL: runtimeUrl,
      SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: expected
    })
  );
  const migration = loadMigrationPostgresConfig(
    migrationEnv({
      SOCIAL_MIGRATIONS_DATABASE_URL: migrationUrl,
      SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: expected
    })
  );
  assert.equal(runtime.targetFingerprint, expected);
  assert.equal(migration.targetFingerprint, expected);
});

test("disabled social runtime needs no database but still rejects privileged URLs", async () => {
  assert.equal(
    assertWebServiceDatabaseCredentialBoundary({
      SOCIAL_PERSISTENCE_ENABLED: "false"
    }),
    true
  );
  assert.deepEqual(
    await createSocialRuntime({
      env: {
        SOCIAL_PERSISTENCE_ENABLED: "false"
      }
    }),
    { enabled: false, reason: "social_persistence_disabled" }
  );
  assert.throws(
    () =>
      assertWebServiceDatabaseCredentialBoundary({
        SOCIAL_PERSISTENCE_ENABLED: "false",
        SOCIAL_MIGRATIONS_DATABASE_URL:
          "synthetic-operator-value-that-is-never-parsed"
      }),
    { code: "web_service_privileged_database_credential_forbidden" }
  );
  assert.throws(
    () =>
      assertWebServiceDatabaseCredentialBoundary({
        SOCIAL_PERSISTENCE_ENABLED: "false",
        DATABASE_URL:
          "postgresql://ia4tube_social_runtime:password@" +
          "db.example.test/social"
      }),
    { code: "web_service_runtime_database_credential_disabled" }
  );
  assert.throws(
    () =>
      assertWebServiceDatabaseCredentialBoundary({
        DATABASE_URL:
          "postgresql://ia4tube_social_runtime:password@" +
          "db.example.test/social"
      }),
    { code: "web_service_runtime_database_credential_disabled" }
  );
});

test("server boot enforces the privileged credential boundary before startup", () => {
  const migrationSecret =
    "postgresql://synthetic_migrator:secret-value-never-log@" +
    "db.example.test/social";
  const privileged = spawnSync(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      JWT_SECRET: "J".repeat(64),
      SOCIAL_PERSISTENCE_ENABLED: "false",
      SOCIAL_MIGRATIONS_DATABASE_URL: migrationSecret
    },
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  const privilegedOutput =
    String(privileged.stdout || "") + String(privileged.stderr || "");
  assert.notEqual(privileged.status, 0);
  assert.match(
    privilegedOutput,
    /web_service_privileged_database_credential_forbidden/
  );
  assert.equal(privilegedOutput.includes("secret-value-never-log"), false);

  const operatorSecret = spawnSync(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      JWT_SECRET: "J".repeat(64),
      SOCIAL_PERSISTENCE_ENABLED: "false",
      SOCIAL_BACKUP_BUNDLE_KEY: "synthetic-operator-secret-never-log"
    },
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  const operatorSecretOutput =
    String(operatorSecret.stdout || "") +
    String(operatorSecret.stderr || "");
  assert.notEqual(operatorSecret.status, 0);
  assert.match(
    operatorSecretOutput,
    /web_service_operator_secret_forbidden/
  );
  assert.equal(
    operatorSecretOutput.includes("synthetic-operator-secret-never-log"),
    false
  );

  const wrongRuntime = spawnSync(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      JWT_SECRET: "J".repeat(64),
      SOCIAL_PERSISTENCE_ENABLED: "true",
      DATABASE_URL:
        "postgresql://wrong_runtime:secret-value-never-log@" +
        "db.example.test/social",
      SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:
        "ia4tube_social_runtime",
      SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
        "postgresql://wrong_runtime:secret-value-never-log@" +
          "db.example.test/social"
      )
    },
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  const runtimeOutput =
    String(wrongRuntime.stdout || "") + String(wrongRuntime.stderr || "");
  assert.notEqual(wrongRuntime.status, 0);
  assert.match(
    runtimeOutput,
    /social_database_expected_runtime_login_mismatch/
  );
  assert.equal(runtimeOutput.includes("secret-value-never-log"), false);
});

test("every AES key is separated from identity, JWT and order-signing secrets before pool creation", async () => {
  const cases = [
    {
      SOCIAL_IDENTITY_DERIVATION_KEY: key(3).toString("base64")
    },
    {
      JWT_SECRET: key(3).toString("base64")
    },
    {
      ...(() => {
        const vault = vaultEnvironment(Buffer.alloc(32, 0x41));
        return {
          SOCIAL_VAULT_KEYS_JSON: vault.keysJson,
          SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT:
            vault.fingerprint
        };
      })(),
      ORDER_MEDIA_SIGNING_SECRET: "A".repeat(32)
    }
  ];

  for (const override of cases) {
    let poolCreations = 0;
    class ForbiddenPool {
      constructor() {
        poolCreations += 1;
      }
    }
    await assert.rejects(
      createSocialRuntime({
        env: socialRuntimeEnv(override),
        PoolClass: ForbiddenPool
      }),
      { code: "social_key_separation_required" }
    );
    assert.equal(poolCreations, 0);
  }
});

test("missing comparison secrets fail closed before pool creation", async () => {
  for (const missing of ["JWT_SECRET", "ORDER_MEDIA_SIGNING_SECRET"]) {
    let poolCreations = 0;
    class ForbiddenPool {
      constructor() {
        poolCreations += 1;
      }
    }
    const env = socialRuntimeEnv();
    delete env[missing];
    await assert.rejects(
      createSocialRuntime({ env, PoolClass: ForbiddenPool }),
      { code: "social_key_separation_secret_missing" }
    );
    assert.equal(poolCreations, 0);
  }
});

test("runtime requires the exact public keyring fingerprint before pool creation", async () => {
  for (const mutation of ["missing", "different"]) {
    let poolCreations = 0;
    class ForbiddenPool {
      constructor() {
        poolCreations += 1;
      }
    }
    const env = socialRuntimeEnv();
    if (mutation === "missing") {
      delete env.SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT;
    } else {
      env.SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT =
        "A".repeat(43);
    }
    await assert.rejects(
      createSocialRuntime({ env, PoolClass: ForbiddenPool }),
      {
        code:
          mutation === "missing"
            ? "vault_keyring_fingerprint_invalid"
            : "vault_keyring_fingerprint_mismatch"
      }
    );
    assert.equal(poolCreations, 0);
  }
});

test("runtime rejects the same key version backed by different material", async () => {
  let poolCreations = 0;
  class ForbiddenPool {
    constructor() {
      poolCreations += 1;
    }
  }
  const env = socialRuntimeEnv();
  const parsed = JSON.parse(env.SOCIAL_VAULT_KEYS_JSON);
  parsed[env.SOCIAL_VAULT_ACTIVE_KEY_VERSION] =
    key(8).toString("base64");
  env.SOCIAL_VAULT_KEYS_JSON = JSON.stringify(parsed);
  await assert.rejects(
    createSocialRuntime({ env, PoolClass: ForbiddenPool }),
    { code: "vault_key_version_material_mismatch" }
  );
  assert.equal(poolCreations, 0);
});
