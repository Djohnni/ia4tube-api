"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  PRIMARY_TARGET_FINGERPRINT,
  RESTORE_TARGET_FINGERPRINT,
  assertLinuxNoFollow,
  main,
  physicalNoFollowProbe,
  safeFailurePayload,
  safeSuccessPayload,
  validatePinnedLinuxGateEnvironment
} = require("../scripts/social-db-backup-restore-linux-gate");
const {
  RESTORE_DISPOSABLE_DATABASE_NAME
} = require(
  "../src/persistence/postgres/disposable-database-lifecycle"
);
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");
const {
  executionCodeManifest
} = require("../src/persistence/postgres/physical-gate-evidence");
const {
  CUSTOM_TRUST_ENVIRONMENT_NAMES
} = require("../src/persistence/postgres/tls");

const RUN_ID = "12345678-1234-4abc-8def-1234567890ab";
const COMMIT = "3204e876401175c37f028eaa8ebbff90c5c909f9";
const CURRENT_MANIFEST = executionCodeManifest();
const EXECUTION_IDENTITY = Object.freeze({
  runId: RUN_ID,
  commit: COMMIT,
  renderCommitVerified: true,
  codeManifestSha256: "e".repeat(64),
  codeManifestFileCount: 42,
  environment: "staging",
  environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
  region: "oregon"
});

function evidenceEnvironment() {
  return {
    SOCIAL_2B_EVIDENCE_RUN_ID: RUN_ID,
    SOCIAL_2B_EVIDENCE_COMMIT: COMMIT,
    RENDER_GIT_COMMIT: COMMIT,
    SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_SHA256:
      CURRENT_MANIFEST.sha256,
    SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_FILE_COUNT:
      String(CURRENT_MANIFEST.fileCount)
  };
}

function evidenceDependencies() {
  return {
    loadIdentity: () => EXECUTION_IDENTITY,
    startEvidence({
      identity,
      sequence,
      databasePurpose,
      databaseName,
      targetFingerprint
    }) {
      return {
        ...identity,
        sequence,
        databasePurpose,
        databaseName,
        targetFingerprint,
        startedAt: `2026-07-31T12:0${sequence}:00.000Z`
      };
    },
    completeEvidence(started) {
      return {
        ...started,
        completedAt: `2026-07-31T12:1${started.sequence}:00.000Z`
      };
    }
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-linux-gate-test-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function outputCapture() {
  let value = "";
  return Object.freeze({
    stream: Object.freeze({
      write(chunk) {
        value += String(chunk);
        return true;
      }
    }),
    read() {
      return value;
    }
  });
}

function backupSuccess(overrides = {}) {
  return {
    ok: true,
    mode: "backup",
    evidenceVerified: true,
    evidenceSha256: "b".repeat(64),
    fileCount: 1,
    bundleSize: 4096,
    bundleSha256: "a".repeat(64),
    bundleFileFsyncConfirmed: true,
    bundleDirectoryFsyncConfirmed: true,
    bundleRoundTripVerified: true,
    temporaryWorkspaceCleanupConfirmed: true,
    plaintextArtifactsAbsent: true,
    ...overrides
  };
}

function restoreSuccess(overrides = {}) {
  return {
    ok: true,
    mode: "restore",
    evidenceVerified: true,
    evidenceSha256: "b".repeat(64),
    runtimeIsolation: true,
    vault: true,
    compatibleWith2A: true,
    temporaryWorkspaceCleanupConfirmed: true,
    plaintextArtifactsAbsent: true,
    ...overrides
  };
}

function completedStep(
  sequence,
  databasePurpose,
  databaseName,
  targetFingerprintValue
) {
  return {
    ...EXECUTION_IDENTITY,
    sequence,
    databasePurpose,
    databaseName,
    targetFingerprint: targetFingerprintValue,
    startedAt: `2026-07-31T12:0${sequence}:00.000Z`,
    completedAt: `2026-07-31T12:1${sequence}:00.000Z`
  };
}

function approvedBackupGatePayload() {
  return {
    ...backupSuccess(),
    ...completedStep(
      1,
      "primary-backup",
      PAID_STAGING_PUBLIC_TARGET.database,
      PRIMARY_TARGET_FINGERPRINT
    )
  };
}

function approvedRestoreGatePayload() {
  return {
    ...restoreSuccess(),
    ...completedStep(
      3,
      "disposable-restore",
      RESTORE_DISPOSABLE_DATABASE_NAME,
      RESTORE_TARGET_FINGERPRINT
    )
  };
}

function restoreEnvironment(overrides = {}) {
  return {
    ...evidenceEnvironment(),
    SOCIAL_RESTORE_WORK_DIRECTORY: path.resolve("synthetic-restore-work"),
    SOCIAL_RESTORE_TARGET_DATABASE_URL:
      "postgresql://synthetic_migration:secret@" +
      "synthetic.example.test/ia4tube_social_disposable_restore" +
      "?sslmode=verify-full",
    SOCIAL_RESTORE_RUNTIME_DATABASE_URL:
      "postgresql://synthetic_runtime:other-secret@" +
      "synthetic.example.test/ia4tube_social_disposable_restore" +
      "?sslmode=verify-full",
    SOCIAL_RESTORE_EXPECTED_MIGRATION_LOGIN: "synthetic_migration",
    SOCIAL_RESTORE_EXPECTED_RUNTIME_LOGIN: "synthetic_runtime",
    SOCIAL_RESTORE_LEGACY_2A_ROOT: path.resolve("synthetic-2a-root"),
    SOCIAL_RESTORE_LABEL: `social-2b-${RUN_ID}`,
    ...overrides
  };
}

function pinnedUrl(login, database, password) {
  return (
    `postgresql://${login}:${password}@` +
    `${PAID_STAGING_PUBLIC_TARGET.host}:` +
    `${PAID_STAGING_PUBLIC_TARGET.port}/${database}` +
    "?sslmode=verify-full"
  );
}

function pinnedBackupEnvironment(overrides = {}) {
  const target = PAID_STAGING_PUBLIC_TARGET;
  return {
    ...evidenceEnvironment(),
    SOCIAL_BACKUP_SOURCE_DATABASE_URL: pinnedUrl(
      target.migrationLogin,
      target.database,
      "Synthetic-Migration-Only-01!"
    ),
    SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL: pinnedUrl(
      target.provisionerLogin,
      target.database,
      "Synthetic-Provisioner-Only-02!"
    ),
    SOCIAL_BACKUP_SOURCE_EXPECTED_HOST: target.host,
    SOCIAL_BACKUP_SOURCE_EXPECTED_PORT: target.port,
    SOCIAL_BACKUP_SOURCE_EXPECTED_DATABASE: target.database,
    SOCIAL_BACKUP_SOURCE_EXPECTED_LOGIN: target.migrationLogin,
    SOCIAL_BACKUP_LABEL: `social-2b-${RUN_ID}`,
    SOCIAL_BACKUP_SOURCE_EXPECTED_FINGERPRINT:
      PRIMARY_TARGET_FINGERPRINT,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_HOST: target.host,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_PORT: target.port,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_DATABASE: target.database,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_LOGIN: target.provisionerLogin,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_FINGERPRINT:
      PRIMARY_TARGET_FINGERPRINT,
    SOCIAL_BACKUP_EXPECTED_MIGRATION_LOGIN: target.migrationLogin,
    SOCIAL_BACKUP_EXPECTED_RUNTIME_LOGIN: target.runtimeLogin,
    SOCIAL_BACKUP_EXPECTED_ENVIRONMENT_ID: target.environmentId,
    SOCIAL_BACKUP_EXPECTED_ENVIRONMENT: "staging",
    ...overrides
  };
}

function pinnedRestoreEnvironment(overrides = {}) {
  const target = PAID_STAGING_PUBLIC_TARGET;
  return {
    ...evidenceEnvironment(),
    SOCIAL_RESTORE_TARGET_DATABASE_URL: pinnedUrl(
      target.migrationLogin,
      RESTORE_DISPOSABLE_DATABASE_NAME,
      "Synthetic-Migration-Only-01!"
    ),
    SOCIAL_RESTORE_RUNTIME_DATABASE_URL: pinnedUrl(
      target.runtimeLogin,
      RESTORE_DISPOSABLE_DATABASE_NAME,
      "Synthetic-Runtime-Only-03!"
    ),
    SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL: pinnedUrl(
      target.provisionerLogin,
      RESTORE_DISPOSABLE_DATABASE_NAME,
      "Synthetic-Provisioner-Only-02!"
    ),
    SOCIAL_RESTORE_TARGET_EXPECTED_HOST: target.host,
    SOCIAL_RESTORE_TARGET_EXPECTED_PORT: target.port,
    SOCIAL_RESTORE_TARGET_EXPECTED_DATABASE:
      RESTORE_DISPOSABLE_DATABASE_NAME,
    SOCIAL_RESTORE_TARGET_EXPECTED_LOGIN: target.migrationLogin,
    SOCIAL_RESTORE_TARGET_EXPECTED_FINGERPRINT:
      RESTORE_TARGET_FINGERPRINT,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_HOST: target.host,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_PORT: target.port,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_DATABASE:
      RESTORE_DISPOSABLE_DATABASE_NAME,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_LOGIN: target.provisionerLogin,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_FINGERPRINT:
      RESTORE_TARGET_FINGERPRINT,
    SOCIAL_RESTORE_EXPECTED_MIGRATION_LOGIN: target.migrationLogin,
    SOCIAL_RESTORE_EXPECTED_RUNTIME_LOGIN: target.runtimeLogin,
    SOCIAL_RESTORE_SOURCE_FINGERPRINT: PRIMARY_TARGET_FINGERPRINT,
    SOCIAL_RESTORE_LABEL: `social-2b-${RUN_ID}`,
    ...overrides
  };
}

test("Linux gate is pinned to the paid staging source and exact restore target", () => {
  assert.equal(
    validatePinnedLinuxGateEnvironment(
      "backup",
      pinnedBackupEnvironment()
    ),
    true
  );
  assert.equal(
    validatePinnedLinuxGateEnvironment(
      "restore",
      pinnedRestoreEnvironment()
    ),
    true
  );
});

test("Linux gate refuses custom trust before target work", () => {
  for (const name of CUSTOM_TRUST_ENVIRONMENT_NAMES) {
    assert.throws(
      () =>
        validatePinnedLinuxGateEnvironment(
          "backup",
          pinnedBackupEnvironment({
            [name]: "synthetic-custom-trust"
          })
        ),
      { code: "social_database_custom_trust_forbidden" }
    );
  }
});

test("Linux gate refuses coherent alternate Render targets", () => {
  const alternateHost =
    "dpg-synthetic-other.oregon-postgres.render.com";
  assert.throws(
    () =>
      validatePinnedLinuxGateEnvironment(
        "backup",
        pinnedBackupEnvironment({
          SOCIAL_BACKUP_SOURCE_DATABASE_URL:
            "postgresql://ia4tube_social_staging_migration:" +
            "Synthetic-Migration-Only-01!@" +
            `${alternateHost}:5432/ia4tube_social_staging` +
            "?sslmode=verify-full",
          SOCIAL_BACKUP_SOURCE_EXPECTED_HOST: alternateHost
        })
      ),
    { code: "linux_gate_backup_source_mismatch" }
  );
  assert.throws(
    () =>
      validatePinnedLinuxGateEnvironment(
        "restore",
        pinnedRestoreEnvironment({
          SOCIAL_RESTORE_TARGET_EXPECTED_DATABASE:
            "ia4tube_social_disposable_restore_other"
        })
      ),
    { code: "linux_gate_restore_target_mismatch" }
  );
});

test("Linux gate refuses another platform before an operator can run", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  let operatorCalled = false;
  const status = await main({
    ...evidenceDependencies(),
    env: {
      SOCIAL_BACKUP_OUTPUT_DIRECTORY: path.resolve("synthetic-backup")
    },
    argv: ["backup"],
    platform: "win32",
    validateTarget: () => true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    noFollowProbe() {
      throw new Error("probe must not run");
    },
    async runOperator() {
      operatorCalled = true;
      return 0;
    }
  });
  assert.equal(status, 1);
  assert.equal(operatorCalled, false);
  assert.equal(stdout.read(), "");
  assert.deepEqual(JSON.parse(stderr.read()), {
    ok: false,
    code: "linux_gate_linux_required"
  });
});

test("Linux gate performs the nofollow probe before strict backup", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  const events = [];
  const outputDirectory = path.resolve("synthetic-backup");
  const env = { SOCIAL_BACKUP_OUTPUT_DIRECTORY: outputDirectory };
  const status = await main({
    ...evidenceDependencies(),
    env,
    argv: ["backup"],
    platform: "linux",
    validateTarget: () => true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    noFollowProbe({ root }) {
      events.push(["probe", root]);
      return true;
    },
    async runOperator(options) {
      assert.equal(options.env, env);
      events.push([
        "operator",
        options.argv[0],
        options.requireBundleDirectoryFsync
      ]);
      options.stdout.write(`${JSON.stringify(backupSuccess())}\n`);
      return 0;
    }
  });
  assert.equal(status, 0);
  assert.equal(stderr.read(), "");
  assert.deepEqual(JSON.parse(stdout.read()), approvedBackupGatePayload());
  assert.deepEqual(events, [
    ["probe", outputDirectory],
    ["operator", "backup", true]
  ]);
});

test("Linux gate never approves an unconfirmed directory fsync", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  const status = await main({
    ...evidenceDependencies(),
    env: {
      SOCIAL_BACKUP_OUTPUT_DIRECTORY: path.resolve("synthetic-backup")
    },
    argv: ["backup"],
    platform: "linux",
    validateTarget: () => true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    noFollowProbe: () => true,
    async runOperator(options) {
      options.stdout.write(
        `${JSON.stringify(
          backupSuccess({ bundleDirectoryFsyncConfirmed: false })
        )}\n`
      );
      return 0;
    }
  });
  assert.equal(status, 1);
  assert.equal(stdout.read(), "");
  assert.deepEqual(JSON.parse(stderr.read()), {
    ok: false,
    code: "linux_gate_backup_durability_unconfirmed"
  });
});

test("Linux gate requires file fsync and encrypted round-trip", async () => {
  for (const override of [
    { bundleFileFsyncConfirmed: false },
    { bundleRoundTripVerified: false }
  ]) {
    const stdout = outputCapture();
    const stderr = outputCapture();
    const status = await main({
      ...evidenceDependencies(),
      env: {
        SOCIAL_BACKUP_OUTPUT_DIRECTORY: path.resolve(
          "synthetic-backup"
        )
      },
      argv: ["backup"],
      platform: "linux",
      validateTarget: () => true,
      stdout: stdout.stream,
      stderr: stderr.stream,
      noFollowProbe: () => true,
      async runOperator(options) {
        options.stdout.write(
          `${JSON.stringify(backupSuccess(override))}\n`
        );
        return 0;
      }
    });
    assert.equal(status, 1);
    assert.equal(stdout.read(), "");
    assert.deepEqual(JSON.parse(stderr.read()), {
      ok: false,
      code: "linux_gate_backup_durability_unconfirmed"
    });
  }
});

test("restore injects all behavioral verifiers and closes them", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  const env = restoreEnvironment();
  const events = [];
  const verifiers = Object.freeze({
    verifierTargetFingerprint: "f".repeat(64),
    verifyRuntimeIsolation: async () => true,
    verifyVault: async () => true,
    verify2ACompatibility: async () => true
  });
  const status = await main({
    ...evidenceDependencies(),
    env,
    argv: ["restore"],
    platform: "linux",
    validateTarget: () => true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    noFollowProbe({ root }) {
      events.push(["probe", root]);
      return true;
    },
    createVerifiers(options) {
      events.push(["create", options]);
      return {
        verifiers,
        async close() {
          events.push(["close"]);
        }
      };
    },
    async runOperator(options) {
      events.push(["operator", options]);
      options.stdout.write(`${JSON.stringify(restoreSuccess())}\n`);
      return 0;
    }
  });

  assert.equal(status, 0);
  assert.equal(stderr.read(), "");
  assert.deepEqual(JSON.parse(stdout.read()), approvedRestoreGatePayload());
  assert.deepEqual(events[0], [
    "probe",
    env.SOCIAL_RESTORE_WORK_DIRECTORY
  ]);
  const expectedTlsEnvironment = {
    NODE_TLS_REJECT_UNAUTHORIZED: undefined
  };
  for (const name of CUSTOM_TRUST_ENVIRONMENT_NAMES) {
    expectedTlsEnvironment[name] = undefined;
  }
  assert.deepEqual(events[1], [
    "create",
    {
      env: expectedTlsEnvironment,
      migrationDatabaseUrl: env.SOCIAL_RESTORE_TARGET_DATABASE_URL,
      runtimeDatabaseUrl: env.SOCIAL_RESTORE_RUNTIME_DATABASE_URL,
      expectedMigrationLogin:
        env.SOCIAL_RESTORE_EXPECTED_MIGRATION_LOGIN,
      expectedRuntimeLogin: env.SOCIAL_RESTORE_EXPECTED_RUNTIME_LOGIN,
      legacy2ARoot: env.SOCIAL_RESTORE_LEGACY_2A_ROOT
    }
  ]);
  assert.equal(events[2][0], "operator");
  assert.equal(events[2][1].verifiers, verifiers);
  assert.equal(events[2][1].requireBundleDirectoryFsync, false);
  assert.deepEqual(events[3], ["close"]);
});

test("restore closes verifiers after an operator refusal", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  let closed = 0;
  const status = await main({
    ...evidenceDependencies(),
    env: restoreEnvironment(),
    argv: ["restore"],
    platform: "linux",
    validateTarget: () => true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    noFollowProbe: () => true,
    createVerifiers() {
      return {
        verifiers: {
          verifierTargetFingerprint: "f".repeat(64),
          verifyRuntimeIsolation: async () => true,
          verifyVault: async () => true,
          verify2ACompatibility: async () => true
        },
        async close() {
          closed += 1;
        }
      };
    },
    async runOperator(options) {
      options.stderr.write(
        `${JSON.stringify({
          ok: false,
          code: "restore_behavioral_validation_failed"
        })}\n`
      );
      return 1;
    }
  });
  assert.equal(status, 1);
  assert.equal(closed, 1);
  assert.equal(stdout.read(), "");
  assert.deepEqual(JSON.parse(stderr.read()), {
    ok: false,
    code: "restore_behavioral_validation_failed"
  });
});

test("restore cleanup failure discards a buffered success", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  const status = await main({
    ...evidenceDependencies(),
    env: restoreEnvironment(),
    argv: ["restore"],
    platform: "linux",
    validateTarget: () => true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    noFollowProbe: () => true,
    createVerifiers() {
      return {
        verifiers: {
          verifierTargetFingerprint: "f".repeat(64),
          verifyRuntimeIsolation: async () => true,
          verifyVault: async () => true,
          verify2ACompatibility: async () => true
        },
        async close() {
          const error = new Error("synthetic cleanup detail");
          error.code = "restore_behavior_cleanup_failed";
          throw error;
        }
      };
    },
    async runOperator(options) {
      options.stdout.write(`${JSON.stringify(restoreSuccess())}\n`);
      return 0;
    }
  });
  assert.equal(status, 1);
  assert.equal(stdout.read(), "");
  assert.deepEqual(JSON.parse(stderr.read()), {
    ok: false,
    code: "restore_behavior_cleanup_failed"
  });
  assert.equal(stderr.read().includes("synthetic cleanup detail"), false);
});

test("unexpected exceptions never disclose their message", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  const sensitive = "postgresql://login:secret@example.test/database";
  const status = await main({
    ...evidenceDependencies(),
    env: {
      SOCIAL_BACKUP_OUTPUT_DIRECTORY: path.resolve("synthetic-backup")
    },
    argv: ["backup"],
    platform: "linux",
    validateTarget: () => true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    noFollowProbe: () => true,
    async runOperator() {
      throw new Error(sensitive);
    }
  });
  assert.equal(status, 1);
  assert.equal(stdout.read(), "");
  assert.deepEqual(JSON.parse(stderr.read()), {
    ok: false,
    code: "linux_gate_failed"
  });
  assert.equal(stderr.read().includes(sensitive), false);
});

test("safe payload helpers retain only approved metadata", () => {
  assert.deepEqual(
    safeFailurePayload(
      JSON.stringify({
        ok: false,
        code: "synthetic_refusal",
        secret: "must disappear"
      }),
      "fallback"
    ),
    { ok: false, code: "synthetic_refusal" }
  );
  assert.deepEqual(
    safeSuccessPayload(
      "backup",
      JSON.stringify({
        ...backupSuccess(),
        bundle: "/protected/must-disappear.ia4sb",
        secret: "must disappear"
      })
    ),
    backupSuccess()
  );
});

test(
  "physical Linux probe rejects a symlink and removes its fixture",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = temporaryDirectory(t);
    const before = fs.readdirSync(root);
    assert.equal(physicalNoFollowProbe({ root }), true);
    assert.deepEqual(fs.readdirSync(root), before);
  }
);

test("nofollow assertion requires physical confirmation", () => {
  assert.throws(
    () =>
      assertLinuxNoFollow({
        platform: "linux",
        root: path.resolve("synthetic"),
        probe: () => false
      }),
    {
      code: "linux_gate_nofollow_unconfirmed",
      name: "SocialPostgresLinuxGateError"
    }
  );
});
