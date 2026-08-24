"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MAX_EXECUTION_PACKAGE_BYTES,
  STAGING_EXACT_EXECUTION_CONTRACT,
  STAGING_EXACT_MIGRATION_PATH,
  STAGING_EXACT_REQUIRED_PROTECTED_PATHS,
  STAGING_EXACT_SQL_SHA256,
  STAGING_EXACT_TARGET,
  assertStagingExactTarget,
  loadStagingExactExecutionPackage,
  stagingExactApproval
} = require("../src/persistence/postgres/staging-exact-0004");
const {
  assertExactStagingTarget,
  validateStagingExactMigrationRequest
} = require("../src/persistence/postgres/migrations");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeFile(root, relativePath, bytes) {
  const file = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staging-exact-0004-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonicalSql = fs.readFileSync(
    path.join(__dirname, "..", ...STAGING_EXACT_MIGRATION_PATH.split("/"))
  );
  assert.equal(sha256(canonicalSql), STAGING_EXACT_SQL_SHA256);
  const protectedContents = new Map();
  for (const relativePath of STAGING_EXACT_REQUIRED_PROTECTED_PATHS) {
    const bytes =
      relativePath === STAGING_EXACT_MIGRATION_PATH
        ? canonicalSql
        : Buffer.from(`protected:${relativePath}\n`, "utf8");
    writeFile(root, relativePath, bytes);
    protectedContents.set(relativePath, bytes);
  }

  const recoveryEvidence = {
    schemaVersion: 1,
    source: "render_control_plane",
    provider: "Render",
    webServiceId: STAGING_EXACT_TARGET.webServiceId,
    databaseServiceId: STAGING_EXACT_TARGET.databaseServiceId,
    databaseMarkerUuid: STAGING_EXACT_TARGET.markerUuid,
    recoveryStatus: "AVAILABLE",
    startsAt: "2026-08-17T12:34:56.000Z",
    window: "7 days",
    concurrentOperation: "NONE",
    reference: "render-recovery-staging-20260824",
    capturedAt: "2026-08-24T12:40:00.000Z"
  };
  const exportEvidence = {
    schemaVersion: 1,
    source: "render_control_plane",
    provider: "Render",
    databaseServiceId: STAGING_EXACT_TARGET.databaseServiceId,
    kind: "OFFICIAL_LOGICAL_EXPORT",
    id: "exp-staging-0003-20260824",
    status: "SUCCEEDED",
    createdAt: "2026-08-24T12:35:00.000Z",
    completedAt: "2026-08-24T12:36:00.000Z",
    retentionUntil: null,
    sizeBytes: null
  };
  const recoveryEvidenceBytes = Buffer.from(
    `${JSON.stringify(recoveryEvidence)}\n`,
    "utf8"
  );
  const exportEvidenceBytes = Buffer.from(
    `${JSON.stringify(exportEvidence)}\n`,
    "utf8"
  );
  const recoveryEvidencePath = writeFile(
    root,
    "evidence/recovery.json",
    recoveryEvidenceBytes
  );
  const exportEvidencePath = writeFile(
    root,
    "evidence/export.json",
    exportEvidenceBytes
  );
  const recoveryEvidenceSha256 = sha256(recoveryEvidenceBytes);
  const exportEvidenceSha256 = sha256(exportEvidenceBytes);

  const executionPackage = {
    schemaVersion: 1,
    commit: "5".repeat(40),
    branch: "social/checkpoint-3c0-staging-exact-preparation-20260824",
    target: { ...STAGING_EXACT_TARGET },
    migration: {
      id: "0004_social_connector_persistence",
      fromProfile: "social-schema-0003",
      toProfile: "social-schema-0004",
      sqlSha256: STAGING_EXACT_SQL_SHA256
    },
    catalog: {
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64)
    },
    execution: structuredClone(STAGING_EXACT_EXECUTION_CONTRACT),
    recovery: {
      provider: "Render",
      source: "render_control_plane",
      recoveryStatus: "AVAILABLE",
      concurrentOperation: "NONE",
      reference: "render-recovery-staging-20260824",
      startsAt: "2026-08-17T12:34:56.000Z",
      window: "7 days",
      capturedAt: "2026-08-24T12:40:00.000Z",
      evidenceSha256: recoveryEvidenceSha256,
      export: {
        provider: "Render",
        source: "render_control_plane",
        kind: "OFFICIAL_LOGICAL_EXPORT",
        id: "exp-staging-0003-20260824",
        status: "SUCCEEDED",
        createdAt: "2026-08-24T12:35:00.000Z",
        completedAt: "2026-08-24T12:36:00.000Z",
        retentionUntil: null,
        sizeBytes: null,
        evidenceSha256: exportEvidenceSha256
      }
    },
    protectedFiles: [...protectedContents.entries()].map(
      ([protectedPath, bytes]) => ({
        path: protectedPath,
        sha256: sha256(bytes)
      })
    )
  };
  const packagePath = path.join(root, "execution-package.json");

  function save(value = executionPackage) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    fs.writeFileSync(packagePath, bytes);
    const packageDigest = sha256(bytes);
    return {
      packageDigest,
      options: {
        packagePath,
        expectedPackageSha256: packageDigest,
        repositoryRoot: root,
        recoveryEvidencePath,
        exportEvidencePath,
        currentTime: "2026-08-24T12:45:00.000Z",
        expectedCommit: executionPackage.commit,
        expectedBranch: executionPackage.branch,
        approval: stagingExactApproval(
          packageDigest,
          value.recovery && value.recovery.evidenceSha256
        )
      }
    };
  }

  return {
    root,
    packagePath,
    recoveryEvidencePath,
    exportEvidencePath,
    recoveryEvidenceSha256,
    exportEvidenceSha256,
    executionPackage,
    save
  };
}

function errorCode(code) {
  return (error) => error && error.code === code;
}

test("closed package produces one frozen, sanitized staging request", (t) => {
  const files = fixture(t);
  const { packageDigest, options } = files.save();
  const loaded = loadStagingExactExecutionPackage(options);

  assert.equal(loaded.packageDigest, packageDigest);
  assert.equal(loaded.executionPackage.target.webServiceId, "srv-d9itiiurnols73fsbmmg");
  assert.equal(
    loaded.executionPackage.target.databaseServiceId,
    "dpg-d9l8u27qj5pc738k3rvg-a"
  );
  assert.deepEqual(loaded.request, {
    fromProfile: "social-schema-0003",
    expectedPending: ["0004_social_connector_persistence"],
    toProfile: "social-schema-0004",
    recoveryReference: "render-recovery-staging-20260824",
    recoveryCapturedAt: "2026-08-24T12:40:00.000Z",
    migrationSha256: STAGING_EXACT_SQL_SHA256,
    executionPackageDigest: packageDigest,
    recoveryEvidenceDigest: files.recoveryEvidenceSha256,
    beforeCatalogSha256: "a".repeat(64),
    afterCatalogSha256: "b".repeat(64),
    recoveryStatus: "AVAILABLE",
    recoveryConcurrentOperation: "NONE",
    renderWebServiceId: "srv-d9itiiurnols73fsbmmg",
    renderDatabaseServiceId: "dpg-d9l8u27qj5pc738k3rvg-a",
    databaseMarkerUuid: "f9001d31-5cb4-471b-87de-96ef7dc7bd4e",
    stagingApproval: stagingExactApproval(
      packageDigest,
      files.recoveryEvidenceSha256
    )
  });
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.executionPackage), true);
  assert.equal(Object.isFrozen(loaded.executionPackage.protectedFiles), true);
  assert.equal(Object.isFrozen(loaded.request), true);
  assert.doesNotThrow(() => validateStagingExactMigrationRequest(loaded.request));
  assert.doesNotThrow(() =>
    assertExactStagingTarget(
      {
        environment: "staging",
        environmentId: STAGING_EXACT_TARGET.markerUuid,
        approval: "APPLY_SOCIAL_MIGRATIONS",
        productionApproval: "",
        host: STAGING_EXACT_TARGET.host,
        port: STAGING_EXACT_TARGET.port,
        database: STAGING_EXACT_TARGET.database,
        username: STAGING_EXACT_TARGET.migrationLogin
      },
      loaded.request
    )
  );
  assert.equal(JSON.stringify(loaded).includes("password"), false);
  assert.equal(JSON.stringify(loaded).includes("DATABASE_URL"), false);
});

test("compiled target pins are exact and service identifiers are not interchangeable", (t) => {
  const files = fixture(t);
  assert.deepEqual(
    assertStagingExactTarget({ ...STAGING_EXACT_TARGET }),
    STAGING_EXACT_TARGET
  );

  const confused = structuredClone(files.executionPackage);
  confused.target.webServiceId = STAGING_EXACT_TARGET.databaseServiceId;
  confused.target.databaseServiceId = STAGING_EXACT_TARGET.webServiceId;
  const { options } = files.save(confused);
  assert.throws(
    () => loadStagingExactExecutionPackage(options),
    errorCode("staging_exact_target_mismatch")
  );
});

test("strict schema refuses raw booleans and unexpected fields", (t) => {
  const files = fixture(t);
  for (const mutate of [
    (value) => {
      value.recovery.recoveryStatus = true;
    },
    (value) => {
      value.recovery.concurrentOperation = false;
    },
    (value) => {
      value.target.databaseUrl = "synthetic-secret";
    }
  ]) {
    const candidate = structuredClone(files.executionPackage);
    mutate(candidate);
    const { options } = files.save(candidate);
    assert.throws(
      () => loadStagingExactExecutionPackage(options),
      (error) =>
        error &&
        [
          "staging_exact_recovery_not_certified",
          "staging_exact_target_invalid"
        ].includes(error.code)
    );
  }
});

test("execution command, gates, rollback and abort criteria are closed", (t) => {
  const files = fixture(t);
  for (const mutate of [
    (value) => {
      value.execution.commandPrefix = "npm run db:social -- apply";
    },
    (value) => {
      value.execution.preGates.pop();
    },
    (value) => {
      value.execution.postGates[0] = "unverified_post_gate";
    },
    (value) => {
      value.execution.automaticRetry = true;
    },
    (value) => {
      value.execution.abortCriteria = [];
    }
  ]) {
    const candidate = structuredClone(files.executionPackage);
    mutate(candidate);
    const { options } = files.save(candidate);
    assert.throws(() => loadStagingExactExecutionPackage(options));
  }
});

test("external package SHA and approval are mandatory and digest-bound", (t) => {
  const files = fixture(t);
  const { options } = files.save();
  assert.throws(
    () =>
      loadStagingExactExecutionPackage({
        ...options,
        expectedPackageSha256: "e".repeat(64)
      }),
    errorCode("staging_exact_package_sha_mismatch")
  );
  assert.throws(
    () =>
      loadStagingExactExecutionPackage({
        ...options,
        approval: stagingExactApproval(
          "e".repeat(64),
          files.recoveryEvidenceSha256
        )
      }),
    errorCode("staging_exact_approval_invalid")
  );
});

test("official recovery and export evidence files are mandatory and digest-bound", (t) => {
  const files = fixture(t);
  const { options } = files.save();
  assert.throws(
    () =>
      loadStagingExactExecutionPackage({
        ...options,
        recoveryEvidencePath: undefined
      }),
    errorCode("staging_exact_recovery_evidence_path_invalid")
  );

  fs.appendFileSync(files.recoveryEvidencePath, " ");
  assert.throws(
    () => loadStagingExactExecutionPackage(options),
    errorCode("staging_exact_recovery_evidence_hash_mismatch")
  );
});

test("official evidence literals must exactly match the execution package", (t) => {
  const files = fixture(t);
  const candidate = structuredClone(files.executionPackage);
  candidate.recovery.window = "14 days";
  const { options } = files.save(candidate);
  assert.throws(
    () => loadStagingExactExecutionPackage(options),
    errorCode("staging_exact_recovery_evidence_mismatch")
  );
});

test("recovery and export evidence must be ordered, fresh and unexpired", (t) => {
  const files = fixture(t);
  for (const mutate of [
    (value) => {
      value.recovery.startsAt = "2026-08-24T12:35:00.000Z";
      value.recovery.capturedAt = "2026-08-24T12:34:56.000Z";
    },
    (value) => {
      value.recovery.export.createdAt = "2026-08-24T12:37:00.000Z";
      value.recovery.export.completedAt = "2026-08-24T12:36:00.000Z";
    }
  ]) {
    const candidate = structuredClone(files.executionPackage);
    mutate(candidate);
    const { options } = files.save(candidate);
    assert.throws(
      () => loadStagingExactExecutionPackage(options),
      errorCode("staging_exact_evidence_timeline_invalid")
    );
  }

  const saved = files.save();
  assert.throws(
    () =>
      loadStagingExactExecutionPackage({
        ...saved.options,
        currentTime: "2026-08-24T13:10:00.001Z"
      }),
    errorCode("staging_exact_evidence_stale")
  );
});

test("canonical SQL pin catches SQL and manifest changed together", (t) => {
  const files = fixture(t);
  const changedSql = Buffer.from("SELECT 'changed';\n", "utf8");
  writeFile(files.root, STAGING_EXACT_MIGRATION_PATH, changedSql);
  const candidate = structuredClone(files.executionPackage);
  candidate.migration.sqlSha256 = sha256(changedSql);
  candidate.protectedFiles.find(
    (entry) => entry.path === STAGING_EXACT_MIGRATION_PATH
  ).sha256 = sha256(changedSql);
  const { options } = files.save(candidate);
  assert.throws(
    () => loadStagingExactExecutionPackage(options),
    errorCode("staging_exact_migration_mismatch")
  );
});

test("protected inventory refuses traversal and changed file content", (t) => {
  const files = fixture(t);
  const traversal = structuredClone(files.executionPackage);
  traversal.protectedFiles.find(
    (entry) => entry.path === "db/migrations/checksums.json"
  ).path = "../outside.json";
  let saved = files.save(traversal);
  assert.throws(
    () => loadStagingExactExecutionPackage(saved.options),
    errorCode("staging_exact_protected_path_invalid")
  );

  saved = files.save();
  writeFile(
    files.root,
    "db/migrations/checksums.json",
    Buffer.from("changed-after-package", "utf8")
  );
  assert.throws(
    () => loadStagingExactExecutionPackage(saved.options),
    errorCode("staging_exact_protected_hash_mismatch")
  );
});

test("protected inventory requires every functional execution file", (t) => {
  const files = fixture(t);
  const candidate = structuredClone(files.executionPackage);
  candidate.protectedFiles = candidate.protectedFiles.filter(
    (entry) => entry.path !== "scripts/social-db-staging-exact-0004.js"
  );
  const { options } = files.save(candidate);
  assert.throws(
    () => loadStagingExactExecutionPackage(options),
    errorCode("staging_exact_protected_inventory_incomplete")
  );
});

test("protected inventory refuses symbolic links when the platform permits them", (t) => {
  const files = fixture(t);
  const target = path.join(files.root, "ordinary-file.js");
  const link = path.join(
    files.root,
    "src",
    "persistence",
    "postgres",
    "migrations.js"
  );
  fs.writeFileSync(target, "ordinary\n");
  fs.rmSync(link);
  try {
    fs.symlinkSync(target, link, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }
  const { options } = files.save();
  assert.throws(
    () => loadStagingExactExecutionPackage(options),
    errorCode("staging_exact_protected_symlink")
  );
});

test("package file itself refuses symbolic links and files over 128 KiB", (t) => {
  const files = fixture(t);
  const saved = files.save();
  const realPackage = path.join(files.root, "real-package.json");
  fs.renameSync(files.packagePath, realPackage);
  try {
    fs.symlinkSync(realPackage, files.packagePath, "file");
    assert.throws(
      () => loadStagingExactExecutionPackage(saved.options),
      errorCode("staging_exact_package_file_invalid")
    );
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
  }

  fs.rmSync(files.packagePath, { force: true });
  fs.writeFileSync(
    files.packagePath,
    Buffer.alloc(MAX_EXECUTION_PACKAGE_BYTES + 1, 0x20)
  );
  assert.throws(
    () => loadStagingExactExecutionPackage(saved.options),
    errorCode("staging_exact_package_too_large")
  );
});

test("recovery and official export must both remain certified", (t) => {
  const files = fixture(t);
  const cases = [
    ["recoveryStatus", "UNAVAILABLE", "staging_exact_recovery_not_certified"],
    ["concurrentOperation", "EXPORT", "staging_exact_recovery_not_certified"],
    ["provider", "Other", "staging_exact_recovery_not_certified"]
  ];
  for (const [field, value, code] of cases) {
    const candidate = structuredClone(files.executionPackage);
    candidate.recovery[field] = value;
    const { options } = files.save(candidate);
    assert.throws(
      () => loadStagingExactExecutionPackage(options),
      errorCode(code)
    );
  }

  for (const [field, value] of [
    ["provider", "Other"],
    ["kind", "CUSTOM_BACKUP"],
    ["status", "RUNNING"]
  ]) {
    const candidate = structuredClone(files.executionPackage);
    candidate.recovery.export[field] = value;
    const { options } = files.save(candidate);
    assert.throws(
      () => loadStagingExactExecutionPackage(options),
      errorCode("staging_exact_export_not_certified")
    );
  }
});
