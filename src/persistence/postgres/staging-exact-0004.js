"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { postgresFail } = require("./errors");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("./staging-provisioner");

const MAX_EXECUTION_PACKAGE_BYTES = 128 * 1024;
const MAX_RECOVERY_EVIDENCE_AGE_MS = 30 * 60 * 1000;
const MAX_EXPORT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const STAGING_EXACT_APPROVAL_PREFIX =
  "APPLY_SOCIAL_STAGING_EXACT_0004:";
const STAGING_EXACT_MIGRATION_ID =
  "0004_social_connector_persistence";
const STAGING_EXACT_FROM_PROFILE = "social-schema-0003";
const STAGING_EXACT_TO_PROFILE = "social-schema-0004";
const STAGING_EXACT_SQL_SHA256 =
  "91f6efc611903c40e16bd37828d5b9c1a03dfae222e1d13b5dc97f81ffde1b5d";
const STAGING_EXACT_MIGRATION_PATH =
  "db/migrations/0004_social_connector_persistence.up.sql";
const STAGING_EXACT_REQUIRED_PROTECTED_PATHS = Object.freeze([
  "db/migrations/0001_social_multitenant_foundation.up.sql",
  "db/migrations/0002_social_connections_and_vault.up.sql",
  "db/migrations/0003_global_vault_key_registry.up.sql",
  STAGING_EXACT_MIGRATION_PATH,
  "db/migrations/checksums.json",
  "package-lock.json",
  "package.json",
  "scripts/social-db-staging-exact-0004.js",
  "src/persistence/postgres/config.js",
  "src/persistence/postgres/errors.js",
  "src/persistence/postgres/migrations.js",
  "src/persistence/postgres/pool.js",
  "src/persistence/postgres/staging-exact-0004.js",
  "src/persistence/postgres/staging-provisioner.js",
  "src/persistence/postgres/tls.js",
  "src/persistence/postgres/validation.js"
].sort());
const STAGING_EXACT_TARGET = Object.freeze({
  webServiceName: "ia4tube-api-staging-checkpoint-a",
  webServiceId: "srv-d9itiiurnols73fsbmmg",
  renderEnvironment: "My project / Staging",
  databaseServiceName: "ia4tube-social-staging",
  databaseServiceId: "dpg-d9l8u27qj5pc738k3rvg-a",
  markerUuid: "f9001d31-5cb4-471b-87de-96ef7dc7bd4e",
  host: "dpg-d9l8u27qj5pc738k3rvg-a.oregon-postgres.render.com",
  port: "5432",
  database: "ia4tube_social_staging",
  migrationLogin: "ia4tube_social_staging_migration",
  tlsMode: "verify-full"
});
const STAGING_EXACT_EXECUTION_CONTRACT = Object.freeze({
  npmScript: "db:social:staging-exact-0004",
  commandPrefix:
    "npm run db:social:staging-exact-0004 -- apply",
  operation: "apply_only_0004",
  automaticRetry: false,
  preGates: Object.freeze([
    "repository_clean_and_pinned",
    "target_identity_exact",
    "external_social_flags_explicitly_false",
    "recovery_evidence_fresh_and_authenticated",
    "official_logical_export_succeeded",
    "tls_verify_full_system_trust",
    "migration_login_exact",
    "ledger_0001_0003_exact",
    "physical_profile_0003_exact",
    "catalog_profile_0003_exact",
    "only_0004_pending",
    "sql_0004_sha256_exact"
  ]),
  postGates: Object.freeze([
    "ledger_0001_0004_exact",
    "ledger_0004_rows_1",
    "pending_migrations_zero",
    "physical_profile_0004_exact",
    "catalog_profile_0004_exact",
    "target_identity_preserved",
    "postcommit_read_only_validated"
  ]),
  rollback: Object.freeze([
    "rollback_before_commit",
    "no_down_migration_after_commit",
    "unknown_commit_requires_read_only_inspection",
    "no_automatic_retry"
  ]),
  abortCriteria: Object.freeze([
    "target_divergence",
    "recovery_or_export_not_certified",
    "evidence_stale_or_expired",
    "ledger_divergence",
    "catalog_divergence",
    "profile_divergence",
    "unexpected_migration",
    "checksum_divergence",
    "external_integration_active",
    "unknown_commit_outcome"
  ])
});
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const BRANCH_PATTERN =
  /^(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/;
const SAFE_REFERENCE_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,199}$/;
const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

function fail(code) {
  postgresFail(code, "Pacote staging-exact 0004 recusado.");
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, expected, code) {
  if (!isPlainObject(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code);
  }
  return value;
}

function requireText(value, pattern, code) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    fail(code);
  }
  return value;
}

function requireSha256(value, code) {
  return requireText(value, SHA256_PATTERN, code);
}

function requireLiteralText(value, code) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(code);
  }
  return value;
}

function sameDigest(left, right) {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex")
  );
}

function sameText(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function stableStat(left, right) {
  return [
    "dev",
    "ino",
    "mode",
    "nlink",
    "size",
    "mtimeNs",
    "ctimeNs"
  ].every((name) => left[name] === right[name]);
}

function statNoFollow(file, code) {
  let stat;
  try {
    stat = fs.lstatSync(file, { bigint: true });
  } catch {
    fail(code);
  }
  if (stat.isSymbolicLink()) fail(code);
  return stat;
}

function readStableRegularFile(file, options = {}) {
  const code = options.code || "staging_exact_file_invalid";
  const before = statNoFollow(file, code);
  if (!before.isFile()) fail(code);
  if (
    options.maxBytes !== undefined &&
    before.size > BigInt(options.maxBytes)
  ) {
    fail(options.tooLargeCode || code);
  }

  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !stableStat(before, opened)) fail(code);

    const hash = crypto.createHash("sha256");
    const chunks = options.returnBytes ? [] : null;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (
        options.maxBytes !== undefined &&
        total > options.maxBytes
      ) {
        fail(options.tooLargeCode || code);
      }
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      if (chunks) chunks.push(Buffer.from(bytes));
    }

    const read = fs.fstatSync(descriptor, { bigint: true });
    const after = statNoFollow(file, code);
    if (
      BigInt(total) !== before.size ||
      !stableStat(before, read) ||
      !stableStat(before, after)
    ) {
      fail(options.changedCode || code);
    }
    return Object.freeze({
      bytes: chunks ? Buffer.concat(chunks, total) : null,
      sha256: hash.digest("hex")
    });
  } catch (error) {
    if (error && error.code && error.name === "SocialPostgresError") {
      throw error;
    }
    fail(code);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The validation result is already fail-closed when the descriptor fails.
      }
    }
  }
}

function canonicalTimestamp(value, code) {
  if (typeof value !== "string" || value !== value.trim()) fail(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(code);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertCompiledTargetPins() {
  const pairs = [
    [PAID_STAGING_PUBLIC_TARGET.environmentId, STAGING_EXACT_TARGET.markerUuid],
    [PAID_STAGING_PUBLIC_TARGET.host, STAGING_EXACT_TARGET.host],
    [PAID_STAGING_PUBLIC_TARGET.port, STAGING_EXACT_TARGET.port],
    [PAID_STAGING_PUBLIC_TARGET.database, STAGING_EXACT_TARGET.database],
    [
      PAID_STAGING_PUBLIC_TARGET.migrationLogin,
      STAGING_EXACT_TARGET.migrationLogin
    ]
  ];
  if (pairs.some(([actual, expected]) => actual !== expected)) {
    fail("staging_exact_compiled_target_drift");
  }
}

function assertStagingExactTarget(target) {
  exactKeys(
    target,
    Object.keys(STAGING_EXACT_TARGET),
    "staging_exact_target_invalid"
  );
  for (const [name, expected] of Object.entries(STAGING_EXACT_TARGET)) {
    if (target[name] !== expected) fail("staging_exact_target_mismatch");
  }
  return deepFreeze({ ...target });
}

function stagingExactApproval(packageDigest, recoveryEvidenceDigest) {
  if (isPlainObject(packageDigest) && recoveryEvidenceDigest === undefined) {
    recoveryEvidenceDigest = packageDigest.recoveryEvidenceDigest;
    packageDigest = packageDigest.packageDigest;
  }
  const packageSha256 = requireSha256(
    packageDigest,
    "staging_exact_approval_package_digest_invalid"
  );
  const recoverySha256 = requireSha256(
    recoveryEvidenceDigest,
    "staging_exact_approval_recovery_digest_invalid"
  );
  return (
    STAGING_EXACT_APPROVAL_PREFIX +
    `${STAGING_EXACT_TARGET.markerUuid}:` +
    `${STAGING_EXACT_SQL_SHA256}:` +
    `${recoverySha256}:` +
    packageSha256
  );
}

function validateMigration(value) {
  exactKeys(
    value,
    ["id", "fromProfile", "toProfile", "sqlSha256"],
    "staging_exact_migration_invalid"
  );
  if (
    value.id !== STAGING_EXACT_MIGRATION_ID ||
    value.fromProfile !== STAGING_EXACT_FROM_PROFILE ||
    value.toProfile !== STAGING_EXACT_TO_PROFILE ||
    value.sqlSha256 !== STAGING_EXACT_SQL_SHA256
  ) {
    fail("staging_exact_migration_mismatch");
  }
  return deepFreeze({ ...value });
}

function validateCatalog(value) {
  exactKeys(
    value,
    ["beforeSha256", "afterSha256"],
    "staging_exact_catalog_invalid"
  );
  const beforeSha256 = requireSha256(
    value.beforeSha256,
    "staging_exact_catalog_invalid"
  );
  const afterSha256 = requireSha256(
    value.afterSha256,
    "staging_exact_catalog_invalid"
  );
  if (sameDigest(beforeSha256, afterSha256)) {
    fail("staging_exact_catalog_invalid");
  }
  return Object.freeze({ beforeSha256, afterSha256 });
}

function validateExactStringArray(value, expected, code) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail(code);
  }
  return Object.freeze([...value]);
}

function validateExecution(value) {
  exactKeys(
    value,
    [
      "npmScript",
      "commandPrefix",
      "operation",
      "automaticRetry",
      "preGates",
      "postGates",
      "rollback",
      "abortCriteria"
    ],
    "staging_exact_execution_contract_invalid"
  );
  if (
    value.npmScript !== STAGING_EXACT_EXECUTION_CONTRACT.npmScript ||
    value.commandPrefix !== STAGING_EXACT_EXECUTION_CONTRACT.commandPrefix ||
    value.operation !== STAGING_EXACT_EXECUTION_CONTRACT.operation ||
    value.automaticRetry !== false
  ) {
    fail("staging_exact_execution_contract_mismatch");
  }
  return deepFreeze({
    npmScript: value.npmScript,
    commandPrefix: value.commandPrefix,
    operation: value.operation,
    automaticRetry: false,
    preGates: validateExactStringArray(
      value.preGates,
      STAGING_EXACT_EXECUTION_CONTRACT.preGates,
      "staging_exact_pre_gates_mismatch"
    ),
    postGates: validateExactStringArray(
      value.postGates,
      STAGING_EXACT_EXECUTION_CONTRACT.postGates,
      "staging_exact_post_gates_mismatch"
    ),
    rollback: validateExactStringArray(
      value.rollback,
      STAGING_EXACT_EXECUTION_CONTRACT.rollback,
      "staging_exact_rollback_contract_mismatch"
    ),
    abortCriteria: validateExactStringArray(
      value.abortCriteria,
      STAGING_EXACT_EXECUTION_CONTRACT.abortCriteria,
      "staging_exact_abort_criteria_mismatch"
    )
  });
}

function validateRecovery(value) {
  exactKeys(
    value,
    [
      "provider",
      "source",
      "recoveryStatus",
      "concurrentOperation",
      "reference",
      "startsAt",
      "window",
      "capturedAt",
      "evidenceSha256",
      "export"
    ],
    "staging_exact_recovery_invalid"
  );
  exactKeys(
    value.export,
    [
      "provider",
      "source",
      "kind",
      "id",
      "status",
      "createdAt",
      "completedAt",
      "retentionUntil",
      "sizeBytes",
      "evidenceSha256"
    ],
    "staging_exact_export_invalid"
  );
  if (
    value.provider !== "Render" ||
    value.source !== "render_control_plane" ||
    value.recoveryStatus !== "AVAILABLE" ||
    value.concurrentOperation !== "NONE"
  ) {
    fail("staging_exact_recovery_not_certified");
  }
  if (
    value.export.provider !== "Render" ||
    value.export.source !== "render_control_plane" ||
    value.export.kind !== "OFFICIAL_LOGICAL_EXPORT" ||
    value.export.status !== "SUCCEEDED"
  ) {
    fail("staging_exact_export_not_certified");
  }
  const validated = deepFreeze({
    provider: value.provider,
    source: value.source,
    recoveryStatus: value.recoveryStatus,
    concurrentOperation: value.concurrentOperation,
    reference: requireText(
      value.reference,
      SAFE_REFERENCE_PATTERN,
      "staging_exact_recovery_reference_invalid"
    ),
    startsAt: canonicalTimestamp(
      value.startsAt,
      "staging_exact_recovery_starts_at_invalid"
    ),
    window: requireLiteralText(
      value.window,
      "staging_exact_recovery_window_invalid"
    ),
    capturedAt: canonicalTimestamp(
      value.capturedAt,
      "staging_exact_recovery_captured_at_invalid"
    ),
    evidenceSha256: requireSha256(
      value.evidenceSha256,
      "staging_exact_recovery_evidence_invalid"
    ),
    export: {
      provider: value.export.provider,
      source: value.export.source,
      kind: value.export.kind,
      id: requireText(
        value.export.id,
        SAFE_REFERENCE_PATTERN,
        "staging_exact_export_id_invalid"
      ),
      status: value.export.status,
      createdAt: canonicalTimestamp(
        value.export.createdAt,
        "staging_exact_export_created_at_invalid"
      ),
      completedAt: canonicalTimestamp(
        value.export.completedAt,
        "staging_exact_export_completed_at_invalid"
      ),
      retentionUntil:
        value.export.retentionUntil === null
          ? null
          : canonicalTimestamp(
              value.export.retentionUntil,
              "staging_exact_export_retention_invalid"
            ),
      sizeBytes:
        value.export.sizeBytes === null
          ? null
          : Number.isSafeInteger(value.export.sizeBytes) &&
        value.export.sizeBytes > 0
            ? value.export.sizeBytes
            : fail("staging_exact_export_size_invalid"),
      evidenceSha256: requireSha256(
        value.export.evidenceSha256,
        "staging_exact_export_evidence_invalid"
      )
    }
  });
  const startsAt = Date.parse(validated.startsAt);
  const capturedAt = Date.parse(validated.capturedAt);
  const createdAt = Date.parse(validated.export.createdAt);
  const completedAt = Date.parse(validated.export.completedAt);
  const retentionUntil =
    validated.export.retentionUntil === null
      ? null
      : Date.parse(validated.export.retentionUntil);
  if (
    startsAt > capturedAt ||
    createdAt > completedAt ||
    completedAt > capturedAt ||
    (retentionUntil !== null && retentionUntil <= completedAt)
  ) {
    fail("staging_exact_evidence_timeline_invalid");
  }
  return validated;
}

function validateProtectedPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath !== relativePath.trim() ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    fail("staging_exact_protected_path_invalid");
  }
  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !SAFE_PATH_SEGMENT_PATTERN.test(segment)
    )
  ) {
    fail("staging_exact_protected_path_invalid");
  }
  return segments;
}

function verifyProtectedFile(root, entry) {
  exactKeys(
    entry,
    ["path", "sha256"],
    "staging_exact_protected_file_invalid"
  );
  const segments = validateProtectedPath(entry.path);
  const expectedSha256 = requireSha256(
    entry.sha256,
    "staging_exact_protected_file_invalid"
  );
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = statNoFollow(current, "staging_exact_protected_symlink");
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail("staging_exact_protected_path_invalid");
    }
  }
  const observed = readStableRegularFile(current, {
    code: "staging_exact_protected_file_invalid",
    changedCode: "staging_exact_protected_file_changed"
  });
  if (!sameDigest(observed.sha256, expectedSha256)) {
    fail("staging_exact_protected_hash_mismatch");
  }
  return Object.freeze({ path: entry.path, sha256: expectedSha256 });
}

function validateProtectedFiles(value, repositoryRoot) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    fail("staging_exact_protected_files_invalid");
  }
  const root = path.resolve(repositoryRoot);
  const rootStat = statNoFollow(root, "staging_exact_repository_root_invalid");
  if (!rootStat.isDirectory()) fail("staging_exact_repository_root_invalid");

  const verified = [];
  let previous = null;
  for (const entry of value) {
    const current = verifyProtectedFile(root, entry);
    if (previous !== null && current.path <= previous) {
      fail("staging_exact_protected_inventory_invalid");
    }
    previous = current.path;
    verified.push(current);
  }
  const migrationEntry = verified.find(
    (entry) => entry.path === STAGING_EXACT_MIGRATION_PATH
  );
  const observedPaths = new Set(verified.map((entry) => entry.path));
  if (
    STAGING_EXACT_REQUIRED_PROTECTED_PATHS.some(
      (requiredPath) => !observedPaths.has(requiredPath)
    )
  ) {
    fail("staging_exact_protected_inventory_incomplete");
  }
  if (
    !migrationEntry ||
    migrationEntry.sha256 !== STAGING_EXACT_SQL_SHA256
  ) {
    fail("staging_exact_migration_protection_mismatch");
  }
  return deepFreeze(verified);
}

function validateExecutionPackage(value, repositoryRoot) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "commit",
      "branch",
      "target",
      "migration",
      "catalog",
      "recovery",
      "execution",
      "protectedFiles"
    ],
    "staging_exact_package_schema_invalid"
  );
  if (value.schemaVersion !== 1) {
    fail("staging_exact_package_schema_invalid");
  }
  const commit = requireText(
    value.commit,
    COMMIT_PATTERN,
    "staging_exact_commit_invalid"
  );
  const branch = requireText(
    value.branch,
    BRANCH_PATTERN,
    "staging_exact_branch_invalid"
  );
  return deepFreeze({
    schemaVersion: 1,
    commit,
    branch,
    target: assertStagingExactTarget(value.target),
    migration: validateMigration(value.migration),
    catalog: validateCatalog(value.catalog),
    recovery: validateRecovery(value.recovery),
    execution: validateExecution(value.execution),
    protectedFiles: validateProtectedFiles(
      value.protectedFiles,
      repositoryRoot
    )
  });
}

function readEvidenceJson(file, expectedSha256, codes) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    fail(codes.path);
  }
  const observed = readStableRegularFile(path.resolve(file), {
    code: codes.file,
    tooLargeCode: codes.tooLarge,
    changedCode: codes.changed,
    maxBytes: MAX_EXECUTION_PACKAGE_BYTES,
    returnBytes: true
  });
  if (!sameDigest(observed.sha256, expectedSha256)) {
    fail(codes.hash);
  }
  try {
    return JSON.parse(observed.bytes.toString("utf8"));
  } catch {
    fail(codes.json);
  }
}

function validateRecoveryEvidence(value, executionPackage) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "source",
      "provider",
      "webServiceId",
      "databaseServiceId",
      "databaseMarkerUuid",
      "recoveryStatus",
      "startsAt",
      "window",
      "concurrentOperation",
      "reference",
      "capturedAt"
    ],
    "staging_exact_recovery_evidence_schema_invalid"
  );
  const recovery = executionPackage.recovery;
  const target = executionPackage.target;
  const expected = {
    schemaVersion: 1,
    source: recovery.source,
    provider: recovery.provider,
    webServiceId: target.webServiceId,
    databaseServiceId: target.databaseServiceId,
    databaseMarkerUuid: target.markerUuid,
    recoveryStatus: recovery.recoveryStatus,
    startsAt: recovery.startsAt,
    window: recovery.window,
    concurrentOperation: recovery.concurrentOperation,
    reference: recovery.reference,
    capturedAt: recovery.capturedAt
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (value[name] !== expectedValue) {
      fail("staging_exact_recovery_evidence_mismatch");
    }
  }
}

function validateExportEvidence(value, executionPackage) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "source",
      "provider",
      "databaseServiceId",
      "kind",
      "id",
      "status",
      "createdAt",
      "completedAt",
      "retentionUntil",
      "sizeBytes"
    ],
    "staging_exact_export_evidence_schema_invalid"
  );
  const exported = executionPackage.recovery.export;
  const expected = {
    schemaVersion: 1,
    source: exported.source,
    provider: exported.provider,
    databaseServiceId: executionPackage.target.databaseServiceId,
    kind: exported.kind,
    id: exported.id,
    status: exported.status,
    createdAt: exported.createdAt,
    completedAt: exported.completedAt,
    retentionUntil: exported.retentionUntil,
    sizeBytes: exported.sizeBytes
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (value[name] !== expectedValue) {
      fail("staging_exact_export_evidence_mismatch");
    }
  }
}

function assertEvidenceFreshness(executionPackage, currentTime) {
  const now =
    currentTime === undefined
      ? Date.now()
      : Date.parse(
          canonicalTimestamp(
            currentTime,
            "staging_exact_current_time_invalid"
          )
        );
  const capturedAt = Date.parse(executionPackage.recovery.capturedAt);
  const completedAt = Date.parse(
    executionPackage.recovery.export.completedAt
  );
  const retentionUntil = executionPackage.recovery.export.retentionUntil;
  if (
    capturedAt > now + MAX_CLOCK_SKEW_MS ||
    now - capturedAt > MAX_RECOVERY_EVIDENCE_AGE_MS ||
    completedAt > now + MAX_CLOCK_SKEW_MS ||
    now - completedAt > MAX_EXPORT_AGE_MS ||
    (retentionUntil !== null && Date.parse(retentionUntil) <= now)
  ) {
    fail("staging_exact_evidence_stale");
  }
}

function loadStagingExactExecutionPackage(options = {}) {
  assertCompiledTargetPins();
  if (
    !isPlainObject(options) ||
    typeof options.packagePath !== "string" ||
    !path.isAbsolute(options.packagePath) ||
    typeof options.repositoryRoot !== "string" ||
    !path.isAbsolute(options.repositoryRoot)
  ) {
    fail("staging_exact_package_options_invalid");
  }
  const expectedPackageSha256 = requireSha256(
    options.expectedPackageSha256,
    "staging_exact_package_expected_sha_invalid"
  );
  const packageFile = readStableRegularFile(
    path.resolve(options.packagePath),
    {
      code: "staging_exact_package_file_invalid",
      tooLargeCode: "staging_exact_package_too_large",
      changedCode: "staging_exact_package_changed",
      maxBytes: MAX_EXECUTION_PACKAGE_BYTES,
      returnBytes: true
    }
  );
  if (!sameDigest(packageFile.sha256, expectedPackageSha256)) {
    fail("staging_exact_package_sha_mismatch");
  }

  let parsed;
  try {
    parsed = JSON.parse(packageFile.bytes.toString("utf8"));
  } catch {
    fail("staging_exact_package_json_invalid");
  }
  const executionPackage = validateExecutionPackage(
    parsed,
    options.repositoryRoot
  );
  const recoveryEvidence = readEvidenceJson(
    options.recoveryEvidencePath,
    executionPackage.recovery.evidenceSha256,
    {
      path: "staging_exact_recovery_evidence_path_invalid",
      file: "staging_exact_recovery_evidence_file_invalid",
      tooLarge: "staging_exact_recovery_evidence_too_large",
      changed: "staging_exact_recovery_evidence_changed",
      hash: "staging_exact_recovery_evidence_hash_mismatch",
      json: "staging_exact_recovery_evidence_json_invalid"
    }
  );
  validateRecoveryEvidence(recoveryEvidence, executionPackage);
  const exportEvidence = readEvidenceJson(
    options.exportEvidencePath,
    executionPackage.recovery.export.evidenceSha256,
    {
      path: "staging_exact_export_evidence_path_invalid",
      file: "staging_exact_export_evidence_file_invalid",
      tooLarge: "staging_exact_export_evidence_too_large",
      changed: "staging_exact_export_evidence_changed",
      hash: "staging_exact_export_evidence_hash_mismatch",
      json: "staging_exact_export_evidence_json_invalid"
    }
  );
  validateExportEvidence(exportEvidence, executionPackage);
  assertEvidenceFreshness(executionPackage, options.currentTime);
  const expectedCommit = requireText(
    options.expectedCommit,
    COMMIT_PATTERN,
    "staging_exact_expected_commit_invalid"
  );
  const expectedBranch = requireText(
    options.expectedBranch,
    BRANCH_PATTERN,
    "staging_exact_expected_branch_invalid"
  );
  if (expectedCommit !== executionPackage.commit) {
    fail("staging_exact_commit_mismatch");
  }
  if (expectedBranch !== executionPackage.branch) {
    fail("staging_exact_branch_mismatch");
  }

  const approval = stagingExactApproval(
    packageFile.sha256,
    executionPackage.recovery.evidenceSha256
  );
  if (!sameText(options.approval, approval)) {
    fail("staging_exact_approval_invalid");
  }
  const request = deepFreeze({
    fromProfile: executionPackage.migration.fromProfile,
    expectedPending: Object.freeze([executionPackage.migration.id]),
    toProfile: executionPackage.migration.toProfile,
    recoveryReference: executionPackage.recovery.reference,
    recoveryCapturedAt: executionPackage.recovery.capturedAt,
    migrationSha256: executionPackage.migration.sqlSha256,
    executionPackageDigest: packageFile.sha256,
    recoveryEvidenceDigest: executionPackage.recovery.evidenceSha256,
    beforeCatalogSha256: executionPackage.catalog.beforeSha256,
    afterCatalogSha256: executionPackage.catalog.afterSha256,
    recoveryStatus: executionPackage.recovery.recoveryStatus,
    recoveryConcurrentOperation:
      executionPackage.recovery.concurrentOperation,
    renderWebServiceId: executionPackage.target.webServiceId,
    renderDatabaseServiceId: executionPackage.target.databaseServiceId,
    databaseMarkerUuid: executionPackage.target.markerUuid,
    stagingApproval: approval
  });
  return deepFreeze({
    packageDigest: packageFile.sha256,
    executionPackage,
    evidenceAuthentication: {
      recoveryFileDigestMatched: true,
      recoveryLiteralsMatched: true,
      exportFileDigestMatched: true,
      exportLiteralsMatched: true
    },
    request
  });
}

module.exports = {
  MAX_EXECUTION_PACKAGE_BYTES,
  MAX_EXPORT_AGE_MS,
  MAX_RECOVERY_EVIDENCE_AGE_MS,
  STAGING_EXACT_APPROVAL_PREFIX,
  STAGING_EXACT_FROM_PROFILE,
  STAGING_EXACT_EXECUTION_CONTRACT,
  STAGING_EXACT_MIGRATION_ID,
  STAGING_EXACT_MIGRATION_PATH,
  STAGING_EXACT_REQUIRED_PROTECTED_PATHS,
  STAGING_EXACT_SQL_SHA256,
  STAGING_EXACT_TARGET,
  STAGING_EXACT_TO_PROFILE,
  assertStagingExactTarget,
  loadStagingExactExecutionPackage,
  stagingExactApproval
};
