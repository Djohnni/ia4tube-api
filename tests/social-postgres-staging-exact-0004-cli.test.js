"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  main,
  parseStagingExactCommand
} = require("../scripts/social-db-staging-exact-0004");

const PACKAGE_SHA256 = "a".repeat(64);
const PACKAGE_PATH = path.resolve("synthetic-staging-exact-package.json");
const RECOVERY_EVIDENCE_PATH = path.resolve("synthetic-recovery-evidence.json");
const EXPORT_EVIDENCE_PATH = path.resolve("synthetic-export-evidence.json");
const APPROVAL = "APPLY_SOCIAL_STAGING_EXACT_0004:synthetic";
const REQUEST = Object.freeze({ stagingApproval: APPROVAL });
const EXPECTED_COMMIT = "5".repeat(40);
const EXPECTED_BRANCH =
  "social/checkpoint-3c0-staging-exact-preparation-20260824";

function argv(command = "plan") {
  return [
    command,
    `--execution-package=${PACKAGE_PATH}`,
    `--execution-package-sha256=${PACKAGE_SHA256}`,
    `--recovery-evidence=${RECOVERY_EVIDENCE_PATH}`,
    `--export-evidence=${EXPORT_EVIDENCE_PATH}`
  ];
}

function environment(overrides = {}) {
  return {
    SOCIAL_STAGING_EXACT_EXPECTED_COMMIT: EXPECTED_COMMIT,
    SOCIAL_STAGING_EXACT_EXPECTED_BRANCH: EXPECTED_BRANCH,
    SOCIAL_STAGING_EXACT_APPROVED: APPROVAL,
    SOCIAL_INSTAGRAM_ENABLED: "false",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    ...overrides
  };
}

function sink() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    read() { return value; }
  };
}

function successfulHarness(options = {}) {
  const calls = [];
  const stdout = sink();
  const stderr = sink();
  const target = Object.freeze({ environment: "staging" });
  const pool = Object.freeze({ syntheticPool: true });
  const plan = Object.freeze({
    fromProfile: "social-schema-0003",
    toProfile: "social-schema-0004",
    expectedPending: ["0004_social_connector_persistence"],
    observedPending: ["0004_social_connector_persistence"],
    beforeCatalogSha256: "b".repeat(64),
    migrationSha256: "c".repeat(64),
    executionPackageDigest: PACKAGE_SHA256,
    recoveryEvidenceDigest: "d".repeat(64),
    planApproved: true,
    readOnly: true,
    password: "must-not-be-serialized"
  });
  const applied = Object.freeze({
    fromProfile: "social-schema-0003",
    toProfile: "social-schema-0004",
    expectedPending: ["0004_social_connector_persistence"],
    observedPending: ["0004_social_connector_persistence"],
    appliedMigration: "0004_social_connector_persistence",
    finalProfile: "social-schema-0004",
    finalCatalogSha256: "e".repeat(64),
    postCommitValidated: true,
    recoveryReferenceDigest: "f".repeat(64),
    recoveryCapturedAt: "2026-08-24T12:34:56.000Z",
    recoveryEvidenceDigest: "d".repeat(64),
    recoveryEvidenceExternallyVerified: false,
    recoveryEvidencePackageBound: true,
    executionPackageDigest: PACKAGE_SHA256,
    retryAllowed: false,
    connectionString: "postgresql://secret@forbidden/database"
  });
  const dependencies = {
    loadPackageImpl(loadOptions) {
      calls.push(["load-package", loadOptions]);
      return Object.freeze({
        packageDigest: PACKAGE_SHA256,
        request: REQUEST,
        evidenceAuthentication: Object.freeze({
          recoveryFileDigestMatched: true,
          recoveryLiteralsMatched: true,
          exportFileDigestMatched: true,
          exportLiteralsMatched: true
        }),
        executionPackage: Object.freeze({
          commit: EXPECTED_COMMIT,
          branch: EXPECTED_BRANCH
        })
      });
    },
    inspectRepositoryImpl(repositoryRoot) {
      calls.push(["inspect-repository", repositoryRoot]);
      return Object.freeze({
        commit: EXPECTED_COMMIT,
        branch: EXPECTED_BRANCH,
        clean: true
      });
    },
    loadConfigImpl(receivedEnv) {
      calls.push(["load-config", receivedEnv]);
      return Object.freeze({
        pool: Object.freeze({ connectionString: "synthetic-secret" }),
        ownerRole: "owner",
        migratorRole: "migrator",
        target
      });
    },
    assertTargetImpl(receivedTarget, request) {
      calls.push(["assert-target", receivedTarget, request]);
    },
    createPoolImpl(poolConfig) {
      calls.push(["create-pool", poolConfig]);
      return pool;
    },
    createRunnerImpl(configuration) {
      calls.push(["create-runner", configuration]);
      return {
        async planStagingExact(request, receivedEnv) {
          calls.push(["plan", request, receivedEnv]);
          return plan;
        },
        async applyStagingExact(request, receivedEnv) {
          calls.push(["apply", request, receivedEnv]);
          if (options.applyFailure) throw options.applyFailure;
          return applied;
        }
      };
    },
    async closePoolImpl(receivedPool) {
      calls.push(["close", receivedPool]);
    }
  };
  return { calls, stdout, stderr, dependencies };
}

test("dedicated parser accepts only plan/apply with absolute package and SHA", () => {
  for (const command of ["plan", "apply"]) {
    assert.deepEqual(parseStagingExactCommand(argv(command)), {
      command,
      packagePath: PACKAGE_PATH,
      expectedPackageSha256: PACKAGE_SHA256,
      recoveryEvidencePath: RECOVERY_EVIDENCE_PATH,
      exportEvidencePath: EXPORT_EVIDENCE_PATH
    });
  }
  for (const candidate of [
    [],
    ["status", ...argv().slice(1)],
    ["plan", "--execution-package=relative.json", ...argv().slice(2)],
    ["plan", argv()[1], "--execution-package-sha256=ABC", ...argv().slice(3)],
    ["plan", ...argv().slice(1, 3), "--recovery-evidence=relative.json", argv()[4]],
    ["plan", ...argv().slice(1, 4), "--export-evidence=relative.json"],
    ["plan", argv()[1]],
    ["plan", ...argv().slice(1), "--unknown=value"],
    ["plan", ...argv().slice(1), argv()[1]]
  ]) {
    assert.throws(() => parseStagingExactCommand(candidate));
  }
});

test("invalid input and active external integrations fail before package or pool", async () => {
  for (const [candidateArgv, candidateEnv, expectedStatus] of [
    [["unknown"], environment(), 2],
    [argv(), environment({ DATABASE_URL: "postgresql://runtime-secret" }), 1],
    [argv(), environment({ META_ACCESS_TOKEN: "secret-token" }), 1],
    [argv(), environment({ SOCIAL_INSTAGRAM_ENABLED: "true" }), 1],
    [argv(), environment({ SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true" }), 1],
    [argv(), environment({ SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true" }), 1],
    [argv(), environment({ DEPLOY_ENABLED: "1" }), 1]
  ]) {
    let packageLoads = 0;
    let poolCreations = 0;
    const stderr = sink();
    const status = await main({
      argv: candidateArgv,
      env: candidateEnv,
      loadPackageImpl() { packageLoads += 1; },
      createPoolImpl() { poolCreations += 1; },
      stderr: stderr.stream,
      stdout: sink().stream
    });
    assert.equal(status, expectedStatus);
    assert.equal(packageLoads, 0);
    assert.equal(poolCreations, 0);
    assert.doesNotMatch(stderr.read(), /runtime-secret|secret-token|postgresql:\/\//i);
  }
});

test("all three canonical social flags must be explicitly false", async () => {
  for (const name of [
    "SOCIAL_INSTAGRAM_ENABLED",
    "SOCIAL_EXTERNAL_CONNECTION_ENABLED",
    "SOCIAL_EXTERNAL_PUBLICATION_ENABLED"
  ]) {
    const env = environment();
    delete env[name];
    let packageLoads = 0;
    const status = await main({
      argv: argv(),
      env,
      loadPackageImpl() { packageLoads += 1; },
      stdout: sink().stream,
      stderr: sink().stream
    });
    assert.equal(status, 1, name);
    assert.equal(packageLoads, 0, name);
  }
});

test("commit, branch and bound approval pins are mandatory before package load", async () => {
  for (const missing of [
    "SOCIAL_STAGING_EXACT_EXPECTED_COMMIT",
    "SOCIAL_STAGING_EXACT_EXPECTED_BRANCH",
    "SOCIAL_STAGING_EXACT_APPROVED"
  ]) {
    const env = environment();
    delete env[missing];
    let loads = 0;
    const status = await main({
      argv: argv(),
      env,
      loadPackageImpl() { loads += 1; },
      stdout: sink().stream,
      stderr: sink().stream
    });
    assert.equal(status, 1);
    assert.equal(loads, 0);
  }
});

test("repository must be clean and match the package before config or pool", async () => {
  for (const repositoryState of [
    { commit: "6".repeat(40), branch: EXPECTED_BRANCH, clean: true },
    { commit: EXPECTED_COMMIT, branch: "other/branch", clean: true },
    { commit: EXPECTED_COMMIT, branch: EXPECTED_BRANCH, clean: false }
  ]) {
    const harness = successfulHarness();
    harness.dependencies.inspectRepositoryImpl = () => repositoryState;
    const status = await main({
      argv: argv(),
      env: environment(),
      stdout: harness.stdout.stream,
      stderr: harness.stderr.stream,
      ...harness.dependencies
    });
    assert.equal(status, 1);
    assert.equal(
      harness.calls.some(([name]) => name === "load-config"),
      false
    );
    assert.equal(
      harness.calls.some(([name]) => name === "create-pool"),
      false
    );
    assert.deepEqual(JSON.parse(harness.stderr.read()), {
      ok: false,
      code: "staging_exact_repository_package_mismatch"
    });
  }
});

test("plan closes package before config/pool and emits an allowlisted result", async () => {
  const harness = successfulHarness();
  const status = await main({
    argv: argv("plan"),
    env: environment(),
    stdout: harness.stdout.stream,
    stderr: harness.stderr.stream,
    ...harness.dependencies
  });
  assert.equal(status, 0);
  assert.deepEqual(
    harness.calls.map(([name]) => name),
    [
      "load-package",
      "inspect-repository",
      "load-config",
      "assert-target",
      "create-pool",
      "create-runner",
      "plan",
      "close"
    ]
  );
  const loadOptions = harness.calls[0][1];
  assert.equal(loadOptions.packagePath, PACKAGE_PATH);
  assert.equal(loadOptions.expectedPackageSha256, PACKAGE_SHA256);
  assert.equal(loadOptions.recoveryEvidencePath, RECOVERY_EVIDENCE_PATH);
  assert.equal(loadOptions.exportEvidencePath, EXPORT_EVIDENCE_PATH);
  assert.equal(loadOptions.expectedCommit, EXPECTED_COMMIT);
  assert.equal(loadOptions.approval, APPROVAL);
  const serialized = harness.stdout.read();
  assert.equal(JSON.parse(serialized).plan.readOnly, true);
  assert.doesNotMatch(serialized, /must-not-be-serialized|synthetic-secret|postgresql:\/\//i);
  assert.equal(harness.stderr.read(), "");
});

test("apply always plans first, executes once, and has no retry path", async () => {
  const harness = successfulHarness();
  const status = await main({
    argv: argv("apply"),
    env: environment(),
    stdout: harness.stdout.stream,
    stderr: harness.stderr.stream,
    ...harness.dependencies
  });
  assert.equal(status, 0);
  assert.deepEqual(
    harness.calls.map(([name]) => name),
    [
      "load-package",
      "inspect-repository",
      "load-config",
      "assert-target",
      "create-pool",
      "create-runner",
      "plan",
      "apply",
      "close"
    ]
  );
  const serialized = harness.stdout.read();
  const result = JSON.parse(serialized).result;
  assert.equal(result.retryAllowed, false);
  assert.equal(result.recoveryEvidenceExternallyVerified, false);
  assert.equal(result.recoveryEvidencePackageBound, true);
  assert.doesNotMatch(serialized, /connectionString|forbidden|postgresql:\/\//i);
});

test("apply ambiguity is sanitized, non-retryable, and closes the pool once", async () => {
  const failure = Object.assign(
    new Error("postgresql://secret@forbidden SQL output"),
    {
      code: "migration_exact_postcommit_validation_failed",
      applied: true,
      retryAllowed: false,
      requiresReadOnlyInspection: true
    }
  );
  const harness = successfulHarness({ applyFailure: failure });
  const status = await main({
    argv: argv("apply"),
    env: environment(),
    stdout: harness.stdout.stream,
    stderr: harness.stderr.stream,
    ...harness.dependencies
  });
  assert.equal(status, 1);
  assert.equal(
    harness.calls.filter(([name]) => name === "apply").length,
    1
  );
  assert.equal(
    harness.calls.filter(([name]) => name === "close").length,
    1
  );
  assert.equal(harness.stdout.read(), "");
  assert.deepEqual(JSON.parse(harness.stderr.read()), {
    ok: false,
    code: "migration_exact_postcommit_validation_failed",
    applied: true,
    retryAllowed: false,
    requiresReadOnlyInspection: true
  });
});

test("untrusted error codes cannot become a secret-bearing output channel", async () => {
  const harness = successfulHarness({
    applyFailure: Object.assign(new Error("secret"), {
      code: "password=secret-token"
    })
  });
  const status = await main({
    argv: argv("apply"),
    env: environment(),
    stdout: harness.stdout.stream,
    stderr: harness.stderr.stream,
    ...harness.dependencies
  });
  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(harness.stderr.read()), {
    ok: false,
    code: "staging_exact_command_failed"
  });
});

test("pool close is part of success and its failure remains sanitized", async () => {
  const harness = successfulHarness();
  harness.dependencies.closePoolImpl = async () => {
    harness.calls.push(["close"]);
    throw Object.assign(new Error("postgresql://close-secret"), {
      code: "password=close-secret"
    });
  };
  const status = await main({
    argv: argv("plan"),
    env: environment(),
    stdout: harness.stdout.stream,
    stderr: harness.stderr.stream,
    ...harness.dependencies
  });
  assert.equal(status, 1);
  assert.equal(harness.stdout.read(), "");
  assert.deepEqual(JSON.parse(harness.stderr.read()), {
    ok: false,
    code: "staging_exact_command_failed"
  });
});

test("a close failure after successful apply can never authorize a retry", async () => {
  const harness = successfulHarness();
  harness.dependencies.closePoolImpl = async () => {
    harness.calls.push(["close"]);
    throw Object.assign(new Error("postgresql://close-secret"), {
      code: "password=close-secret"
    });
  };
  const status = await main({
    argv: argv("apply"),
    env: environment(),
    stdout: harness.stdout.stream,
    stderr: harness.stderr.stream,
    ...harness.dependencies
  });
  assert.equal(status, 1);
  assert.equal(harness.stdout.read(), "");
  assert.deepEqual(JSON.parse(harness.stderr.read()), {
    ok: false,
    code: "staging_exact_command_failed",
    applied: true,
    retryAllowed: false,
    requiresReadOnlyInspection: true
  });
});
