"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  targetFingerprint
} = require("./backup-restore");
const {
  RESTORE_DISPOSABLE_DATABASE_NAME,
  disposableDatabaseTargetFingerprint
} = require("./disposable-database-lifecycle");
const {
  COMMIT_PATTERN,
  SHA256_PATTERN,
  UUID_V4_PATTERN
} = require("./physical-gate-evidence");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("./staging-provisioner");

const REPORT_FORMAT =
  "ia4tube-social-2b-backup-restore-evidence";
const REPORT_FORMAT_VERSION = 1;
const CHECKPOINT = "social-2b-tls-external";
const LEGACY_2A_COMMIT =
  "9deb1e04249026a7046d44d6cbf4e2da87b9a0a4";
const MAX_EVIDENCE_BYTES = 16 * 1024;
const SAFE_BUNDLE_NAME =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,126}\.ia4sb$/;
const PRIMARY_TARGET_FINGERPRINT = targetFingerprint({
  host: PAID_STAGING_PUBLIC_TARGET.host,
  port: PAID_STAGING_PUBLIC_TARGET.port,
  database: PAID_STAGING_PUBLIC_TARGET.database
});
const RESTORE_TARGET_FINGERPRINT = targetFingerprint({
  host: PAID_STAGING_PUBLIC_TARGET.host,
  port: PAID_STAGING_PUBLIC_TARGET.port,
  database: RESTORE_DISPOSABLE_DATABASE_NAME
});
const RESTORE_DISPOSABLE_LIFECYCLE_FINGERPRINT =
  disposableDatabaseTargetFingerprint(
    RESTORE_DISPOSABLE_DATABASE_NAME
  );
const COMMON_STEP_KEYS = Object.freeze([
  "codeManifestFileCount",
  "codeManifestSha256",
  "commit",
  "completedAt",
  "databaseName",
  "databasePurpose",
  "environment",
  "environmentId",
  "region",
  "renderCommitVerified",
  "runId",
  "sequence",
  "startedAt",
  "targetFingerprint"
]);

class SocialBackupEvidenceReportError extends Error {
  constructor(code) {
    super(code);
    this.name = "SocialBackupEvidenceReportError";
    this.code = code;
  }
}

function fail(code) {
  throw new SocialBackupEvidenceReportError(code);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, expected, code) {
  if (!isPlainObject(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((name, index) => name !== wanted[index])
  ) {
    fail(code);
  }
}

function sameIdentity(left, right) {
  return (
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  );
}

function sameStableIdentity(left, right) {
  return (
    sameIdentity(left, right) &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    (left.mode & 0o7777) === (right.mode & 0o7777)
  );
}

function sameObject(left, right) {
  return (
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function requireAbsoluteFile(file, code) {
  if (
    typeof file !== "string" ||
    file !== file.trim() ||
    !path.isAbsolute(file) ||
    file.includes("\0")
  ) {
    fail(code);
  }
  return path.resolve(file);
}

function readStableFile(
  file,
  {
    fileSystem = fs,
    maximumBytes = MAX_EVIDENCE_BYTES,
    code = "social_evidence_file_invalid",
    expectedIdentity,
    requireNoFollow = process.platform === "linux"
  } = {}
) {
  const target = requireAbsoluteFile(file, code);
  const before = fileSystem.lstatSync(target);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size < 1 ||
    before.size > maximumBytes
  ) {
    fail(code);
  }
  let descriptor;
  let bytes;
  try {
    let flags = fs.constants.O_RDONLY;
    if (requireNoFollow) {
      if (
        !Number.isSafeInteger(fs.constants.O_NOFOLLOW) ||
        fs.constants.O_NOFOLLOW === 0
      ) {
        fail(`${code}_nofollow_unavailable`);
      }
      flags |= fs.constants.O_NOFOLLOW;
    }
    descriptor = fileSystem.openSync(target, flags);
    const opened = fileSystem.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      !sameStableIdentity(before, opened) ||
      (expectedIdentity &&
        !sameStableIdentity(expectedIdentity, opened))
    ) {
      fail(code);
    }
    bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fileSystem.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (count < 1) fail(code);
      offset += count;
    }
    const after = fileSystem.fstatSync(descriptor);
    if (!sameStableIdentity(opened, after)) fail(code);
    return bytes;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function readSafeJsonEvidence(file, label, fileSystem = fs) {
  const code = `social_evidence_${label}_invalid`;
  const bytes = readStableFile(file, { fileSystem, code });
  try {
    const serialized = bytes.toString("utf8");
    if (
      !serialized.trim() ||
      serialized.trim().includes("\n") ||
      serialized.trim().includes("\r")
    ) {
      fail(code);
    }
    let payload;
    try {
      payload = JSON.parse(serialized);
    } catch {
      fail(code);
    }
    if (!isPlainObject(payload)) fail(code);
    return payload;
  } finally {
    bytes.fill(0);
  }
}

function canonicalIso(value, code) {
  if (typeof value !== "string" || value !== value.trim()) fail(code);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    fail(code);
  }
  return value;
}

function normalizeStepCommon(
  payload,
  {
    sequence,
    databasePurpose,
    databaseName,
    targetFingerprint: expectedFingerprint,
    code
  }
) {
  if (
    !UUID_V4_PATTERN.test(String(payload.runId || "")) ||
    !COMMIT_PATTERN.test(String(payload.commit || "")) ||
    payload.renderCommitVerified !== true ||
    !SHA256_PATTERN.test(String(payload.codeManifestSha256 || "")) ||
    !Number.isSafeInteger(payload.codeManifestFileCount) ||
    payload.codeManifestFileCount < 1 ||
    payload.environment !== "staging" ||
    payload.environmentId !== PAID_STAGING_PUBLIC_TARGET.environmentId ||
    payload.region !== "oregon" ||
    payload.sequence !== sequence ||
    payload.databasePurpose !== databasePurpose ||
    payload.databaseName !== databaseName ||
    payload.targetFingerprint !== expectedFingerprint
  ) {
    fail(code);
  }
  const startedAt = canonicalIso(payload.startedAt, code);
  const completedAt = canonicalIso(payload.completedAt, code);
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail(code);
  return Object.freeze({
    runId: payload.runId,
    commit: payload.commit,
    renderCommitVerified: true,
    codeManifestSha256: payload.codeManifestSha256,
    codeManifestFileCount: payload.codeManifestFileCount,
    environment: "staging",
    environmentId: payload.environmentId,
    region: "oregon",
    sequence,
    databasePurpose,
    databaseName,
    targetFingerprint: expectedFingerprint,
    startedAt,
    completedAt
  });
}

function normalizeBackup(payload) {
  assertExactKeys(
    payload,
    [
      "bundleDirectoryFsyncConfirmed",
      "bundleFileFsyncConfirmed",
      "bundleRoundTripVerified",
      "bundleSha256",
      "bundleSize",
      "evidenceSha256",
      "evidenceVerified",
      "fileCount",
      "mode",
      "ok",
      "plaintextArtifactsAbsent",
      "temporaryWorkspaceCleanupConfirmed",
      ...COMMON_STEP_KEYS
    ],
    "social_evidence_backup_invalid"
  );
  if (
    payload.ok !== true ||
    payload.mode !== "backup" ||
    payload.evidenceVerified !== true ||
    payload.fileCount !== 1 ||
    !Number.isSafeInteger(payload.bundleSize) ||
    payload.bundleSize < 1 ||
    !SHA256_PATTERN.test(payload.bundleSha256) ||
    !SHA256_PATTERN.test(payload.evidenceSha256) ||
    payload.bundleFileFsyncConfirmed !== true ||
    payload.bundleDirectoryFsyncConfirmed !== true ||
    payload.bundleRoundTripVerified !== true ||
    payload.temporaryWorkspaceCleanupConfirmed !== true ||
    payload.plaintextArtifactsAbsent !== true
  ) {
    fail("social_evidence_backup_invalid");
  }
  return Object.freeze({
    ...payload,
    step: normalizeStepCommon(payload, {
      sequence: 1,
      databasePurpose: "primary-backup",
      databaseName: PAID_STAGING_PUBLIC_TARGET.database,
      targetFingerprint: PRIMARY_TARGET_FINGERPRINT,
      code: "social_evidence_backup_invalid"
    })
  });
}

function normalizeRestore(payload) {
  assertExactKeys(
    payload,
    [
      "compatibleWith2A",
      "evidenceSha256",
      "evidenceVerified",
      "mode",
      "ok",
      "runtimeIsolation",
      "vault",
      "plaintextArtifactsAbsent",
      "temporaryWorkspaceCleanupConfirmed",
      ...COMMON_STEP_KEYS
    ],
    "social_evidence_restore_invalid"
  );
  if (
    payload.ok !== true ||
    payload.mode !== "restore" ||
    payload.evidenceVerified !== true ||
    !SHA256_PATTERN.test(payload.evidenceSha256) ||
    payload.runtimeIsolation !== true ||
    payload.vault !== true ||
    payload.compatibleWith2A !== true ||
    payload.temporaryWorkspaceCleanupConfirmed !== true ||
    payload.plaintextArtifactsAbsent !== true
  ) {
    fail("social_evidence_restore_invalid");
  }
  return Object.freeze({
    ...payload,
    step: normalizeStepCommon(payload, {
      sequence: 3,
      databasePurpose: "disposable-restore",
      databaseName: RESTORE_DISPOSABLE_DATABASE_NAME,
      targetFingerprint: RESTORE_TARGET_FINGERPRINT,
      code: "social_evidence_restore_invalid"
    })
  });
}

function normalizeCreate(payload) {
  assertExactKeys(
    payload,
    [
      "absenceConfirmed",
      "created",
      "dropped",
      "identityVerified",
      "ok",
      "restoreTopologyPrepared",
      "safe",
      "sessionsTerminated",
      ...COMMON_STEP_KEYS
    ],
    "social_evidence_create_invalid"
  );
  if (
    payload.ok !== true ||
    payload.safe !== true ||
    payload.created !== true ||
    payload.dropped !== false ||
    payload.identityVerified !== true ||
    payload.sessionsTerminated !== false ||
    payload.absenceConfirmed !== false ||
    payload.restoreTopologyPrepared !== true
  ) {
    fail("social_evidence_create_invalid");
  }
  return Object.freeze({
    ...payload,
    step: normalizeStepCommon(payload, {
      sequence: 2,
      databasePurpose: "disposable-restore",
      databaseName: RESTORE_DISPOSABLE_DATABASE_NAME,
      targetFingerprint: RESTORE_DISPOSABLE_LIFECYCLE_FINGERPRINT,
      code: "social_evidence_create_invalid"
    })
  });
}

function normalizeDrop(payload) {
  assertExactKeys(
    payload,
    [
      "absenceConfirmed",
      "created",
      "dropped",
      "identityVerified",
      "ok",
      "safe",
      "sessionsTerminated",
      ...COMMON_STEP_KEYS
    ],
    "social_evidence_drop_invalid"
  );
  if (
    payload.ok !== true ||
    payload.safe !== true ||
    payload.created !== false ||
    payload.dropped !== true ||
    payload.identityVerified !== true ||
    payload.sessionsTerminated !== true ||
    payload.absenceConfirmed !== true
  ) {
    fail("social_evidence_drop_invalid");
  }
  return Object.freeze({
    ...payload,
    step: normalizeStepCommon(payload, {
      sequence: 4,
      databasePurpose: "disposable-restore",
      databaseName: RESTORE_DISPOSABLE_DATABASE_NAME,
      targetFingerprint: RESTORE_DISPOSABLE_LIFECYCLE_FINGERPRINT,
      code: "social_evidence_drop_invalid"
    })
  });
}

function hashStableFile(
  file,
  {
    fileSystem = fs,
    namePattern,
    code = "social_evidence_file_hash_invalid",
    expectedIdentity,
    requireNoFollow = process.platform === "linux"
  } = {}
) {
  const target = requireAbsoluteFile(
    file,
    code
  );
  const name = path.basename(target);
  if (namePattern && !namePattern.test(name)) fail(code);
  const before = fileSystem.lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1) {
    fail(code);
  }
  let descriptor;
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let flags = fs.constants.O_RDONLY;
    if (requireNoFollow) {
      if (
        !Number.isSafeInteger(fs.constants.O_NOFOLLOW) ||
        fs.constants.O_NOFOLLOW === 0
      ) {
        fail(`${code}_nofollow_unavailable`);
      }
      flags |= fs.constants.O_NOFOLLOW;
    }
    descriptor = fileSystem.openSync(target, flags);
    const opened = fileSystem.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      !sameStableIdentity(before, opened) ||
      (expectedIdentity &&
        !sameStableIdentity(expectedIdentity, opened))
    ) {
      fail(code);
    }
    while (true) {
      const count = fileSystem.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null
      );
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
    const after = fileSystem.fstatSync(descriptor);
    if (!sameStableIdentity(opened, after)) {
      fail(`${code}_changed`);
    }
    return Object.freeze({
      name,
      size: after.size,
      sha256: digest.digest("hex"),
      identity: after
    });
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function hashStableBundle(file, fileSystem = fs) {
  return hashStableFile(file, {
    fileSystem,
    namePattern: SAFE_BUNDLE_NAME,
    code: "social_evidence_bundle_invalid"
  });
}

function assertProtectedDirectory(directory, fileSystem = fs) {
  const target = path.resolve(directory);
  const metadata = fileSystem.lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("social_evidence_report_directory_invalid");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    fail("social_evidence_report_directory_permissions_invalid");
  }
  const real = path.resolve(fileSystem.realpathSync(target));
  if (real !== target) {
    fail("social_evidence_report_directory_invalid");
  }
  let ancestor = target;
  while (true) {
    if (fileSystem.existsSync(path.join(ancestor, ".git"))) {
      fail("social_evidence_report_inside_git_refused");
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return Object.freeze({ path: target, identity: metadata });
}

function assertDirectoryIdentity(binding, fileSystem = fs) {
  if (!binding?.path || !binding?.identity) {
    fail("social_evidence_report_directory_invalid");
  }
  let current;
  let real;
  try {
    current = fileSystem.lstatSync(binding.path);
    real = path.resolve(fileSystem.realpathSync(binding.path));
  } catch {
    fail("social_evidence_report_directory_changed");
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameObject(binding.identity, current) ||
    (binding.identity.mode & 0o7777) !== (current.mode & 0o7777) ||
    real !== binding.path
  ) {
    fail("social_evidence_report_directory_changed");
  }
  return true;
}

function fsyncDirectory(binding, fileSystem = fs) {
  let descriptor;
  try {
    assertDirectoryIdentity(binding, fileSystem);
    let flags = fs.constants.O_RDONLY;
    if (process.platform === "linux") {
      if (
        !Number.isSafeInteger(fs.constants.O_NOFOLLOW) ||
        fs.constants.O_NOFOLLOW === 0
      ) {
        fail("social_evidence_report_directory_nofollow_unavailable");
      }
      flags |= fs.constants.O_NOFOLLOW;
      if (Number.isSafeInteger(fs.constants.O_DIRECTORY)) {
        flags |= fs.constants.O_DIRECTORY;
      }
    }
    descriptor = fileSystem.openSync(binding.path, flags);
    const opened = fileSystem.fstatSync(descriptor);
    if (
      !opened.isDirectory() ||
      !sameObject(binding.identity, opened)
    ) {
      fail("social_evidence_report_directory_changed");
    }
    fileSystem.fsyncSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    if (!sameObject(opened, after)) {
      fail("social_evidence_report_directory_changed");
    }
  } catch {
    fail("social_evidence_report_directory_fsync_failed");
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function removeOwnedFile(file, identity, fileSystem = fs) {
  try {
    const current = fileSystem.lstatSync(file);
    if (!sameObject(identity, current)) return false;
    fileSystem.unlinkSync(file);
    try {
      fileSystem.lstatSync(file);
      return false;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  } catch (error) {
    // Once an inode was created by this execution, an unexplained missing
    // pathname cannot prove that the inode itself was deleted rather than
    // renamed elsewhere.
    return false;
  }
}

function publishExclusiveFile(
  finalPath,
  bytes,
  directoryBinding,
  fileSystem = fs
) {
  const partialPath = `${finalPath}.partial`;
  let descriptor;
  let partialIdentity;
  let finalCreated = false;
  let partialRemoved = false;
  try {
    assertDirectoryIdentity(directoryBinding, fileSystem);
    descriptor = fileSystem.openSync(
      partialPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL,
      0o600
    );
    partialIdentity = fileSystem.fstatSync(descriptor);
    fileSystem.writeFileSync(descriptor, bytes);
    fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.fsyncSync(descriptor);
    const completed = fileSystem.fstatSync(descriptor);
    if (
      !completed.isFile() ||
      completed.size !== bytes.length ||
      !sameObject(partialIdentity, completed)
    ) {
      fail("social_evidence_report_file_changed");
    }
    partialIdentity = completed;
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.linkSync(partialPath, finalPath);
    finalCreated = true;
    const published = fileSystem.lstatSync(finalPath);
    if (!sameIdentity(partialIdentity, published)) {
      fail("social_evidence_report_publication_invalid");
    }
    fileSystem.unlinkSync(partialPath);
    if (fileSystem.existsSync(partialPath)) {
      fail("social_evidence_report_cleanup_failed");
    }
    partialRemoved = true;
    const stablePublished = fileSystem.lstatSync(finalPath);
    if (!sameIdentity(partialIdentity, stablePublished)) {
      fail("social_evidence_report_publication_invalid");
    }
    return Object.freeze({
      ownedIdentity: partialIdentity,
      stableIdentity: stablePublished,
      partialPath
    });
  } catch (error) {
    let cleanupConfirmed = true;
    let directoryCurrent = true;
    try {
      assertDirectoryIdentity(directoryBinding, fileSystem);
    } catch {
      directoryCurrent = false;
      cleanupConfirmed = false;
    }
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // The stable report failure remains authoritative.
      }
    }
    if (directoryCurrent && partialIdentity && !partialRemoved) {
      cleanupConfirmed =
        removeOwnedFile(partialPath, partialIdentity, fileSystem) &&
        cleanupConfirmed;
    }
    if (directoryCurrent && finalCreated && partialIdentity) {
      cleanupConfirmed =
        removeOwnedFile(finalPath, partialIdentity, fileSystem) &&
        cleanupConfirmed;
    }
    if (!cleanupConfirmed) {
      fail("social_evidence_report_cleanup_failed");
    }
    if (error instanceof SocialBackupEvidenceReportError) throw error;
    fail("social_evidence_report_publication_failed");
  }
}

function stableIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    fail("social_evidence_completed_at_invalid");
  }
  const iso = date.toISOString();
  if (typeof value === "string" && iso !== value) {
    fail("social_evidence_completed_at_invalid");
  }
  return iso;
}

function buildDurableEvidenceReport({
  backup,
  create,
  restore,
  drop,
  bundle,
  currentIdentity,
  completedAt = new Date()
}) {
  const normalizedBackup = normalizeBackup(backup);
  const normalizedCreate = normalizeCreate(create);
  const normalizedRestore = normalizeRestore(restore);
  const normalizedDrop = normalizeDrop(drop);
  if (
    !bundle ||
    bundle.size !== normalizedBackup.bundleSize ||
    bundle.sha256 !== normalizedBackup.bundleSha256
  ) {
    fail("social_evidence_bundle_hash_mismatch");
  }
  if (
    normalizedBackup.evidenceSha256 !==
    normalizedRestore.evidenceSha256
  ) {
    fail("social_evidence_restore_digest_mismatch");
  }
  const steps = [
    normalizedBackup.step,
    normalizedCreate.step,
    normalizedRestore.step,
    normalizedDrop.step
  ];
  const authority = normalizedBackup.step;
  for (const step of steps) {
    if (
      step.runId !== authority.runId ||
      step.commit !== authority.commit ||
      step.codeManifestSha256 !== authority.codeManifestSha256 ||
      step.codeManifestFileCount !== authority.codeManifestFileCount ||
      step.environmentId !== authority.environmentId
    ) {
      fail("social_evidence_execution_mismatch");
    }
  }
  for (let index = 1; index < steps.length; index += 1) {
    if (
      Date.parse(steps[index - 1].completedAt) >
      Date.parse(steps[index].startedAt)
    ) {
      fail("social_evidence_step_order_invalid");
    }
  }
  if (
    !currentIdentity ||
    currentIdentity.runId !== authority.runId ||
    currentIdentity.commit !== authority.commit ||
    currentIdentity.renderCommitVerified !== true ||
    currentIdentity.codeManifestSha256 !== authority.codeManifestSha256 ||
    currentIdentity.codeManifestFileCount !==
      authority.codeManifestFileCount ||
    currentIdentity.environmentId !== authority.environmentId
  ) {
    fail("social_evidence_current_code_mismatch");
  }
  if (bundle.name !== `social-2b-${authority.runId}.ia4sb`) {
    fail("social_evidence_bundle_name_mismatch");
  }
  const reportCompletedAt = stableIso(completedAt);
  if (
    Date.parse(reportCompletedAt) <
    Date.parse(normalizedDrop.step.completedAt)
  ) {
    fail("social_evidence_completed_at_invalid");
  }
  return Object.freeze({
    format: REPORT_FORMAT,
    formatVersion: REPORT_FORMAT_VERSION,
    checkpoint: CHECKPOINT,
    runId: authority.runId,
    completedAt: reportCompletedAt,
    ok: true,
    code: Object.freeze({
      commit: authority.commit,
      renderCommitVerified: true,
      manifestSha256: authority.codeManifestSha256,
      manifestFileCount: authority.codeManifestFileCount,
      legacy2ACommit: LEGACY_2A_COMMIT
    }),
    source: Object.freeze({
      environment: "staging",
      environmentId: authority.environmentId,
      region: "oregon",
      primaryDatabase: PAID_STAGING_PUBLIC_TARGET.database,
      disposableDatabase: RESTORE_DISPOSABLE_DATABASE_NAME,
      primaryTargetFingerprint: PRIMARY_TARGET_FINGERPRINT,
      restoreTargetFingerprint: RESTORE_TARGET_FINGERPRINT,
      disposableDatabaseLifecycleFingerprint:
        RESTORE_DISPOSABLE_LIFECYCLE_FINGERPRINT
    }),
    tls: Object.freeze({
      mode: "verify-full",
      minimumVersion: "TLSv1.2",
      defaultTrustStore: true,
      customCa: false,
      certificatePinning: false
    }),
    executor: Object.freeze({
      platform: "linux",
      nodeVersion: process.version,
      postgresToolsMajor18: true,
      noFollowConfirmed: true
    }),
    steps: Object.freeze({
      backup: Object.freeze({
        sequence: 1,
        startedAt: normalizedBackup.step.startedAt,
        completedAt: normalizedBackup.step.completedAt,
        ok: true,
        targetFingerprint: normalizedBackup.step.targetFingerprint,
        evidenceSha256: normalizedBackup.evidenceSha256,
        fileCount: 1,
        bundleFile: bundle.name,
        bundleSizeBytes: bundle.size,
        bundleSha256: bundle.sha256,
        bundleFileFsyncConfirmed: true,
        bundleDirectoryFsyncConfirmed: true,
        bundleRoundTripVerified: true,
        independentHashVerified: true
      }),
      create: Object.freeze({
        sequence: 2,
        startedAt: normalizedCreate.step.startedAt,
        completedAt: normalizedCreate.step.completedAt,
        ok: true,
        targetFingerprint: normalizedCreate.step.targetFingerprint,
        safe: true,
        created: true,
        identityVerified: true,
        restoreTopologyPrepared: true
      }),
      restore: Object.freeze({
        sequence: 3,
        startedAt: normalizedRestore.step.startedAt,
        completedAt: normalizedRestore.step.completedAt,
        ok: true,
        targetFingerprint: normalizedRestore.step.targetFingerprint,
        evidenceSha256: normalizedRestore.evidenceSha256,
        restoredContentMatchesBackup: true,
        runtimeIsolation: true,
        vault: true,
        compatibleWith2A: true
      }),
      drop: Object.freeze({
        sequence: 4,
        startedAt: normalizedDrop.step.startedAt,
        completedAt: normalizedDrop.step.completedAt,
        ok: true,
        targetFingerprint: normalizedDrop.step.targetFingerprint,
        safe: true,
        dropped: true,
        identityVerified: true,
        sessionsTerminated: true,
        absenceConfirmed: true
      })
    }),
    postconditions: Object.freeze({
      disposableDatabaseAbsent: true,
      ownedTemporaryWorkspacesAbsent:
        normalizedBackup.temporaryWorkspaceCleanupConfirmed === true &&
        normalizedRestore.temporaryWorkspaceCleanupConfirmed === true,
      plaintextArtifactsAbsent:
        normalizedBackup.plaintextArtifactsAbsent === true &&
        normalizedRestore.plaintextArtifactsAbsent === true,
      bundlePresentAndHashVerified: true
    })
  });
}

function publishDurableEvidenceReport({
  report,
  reportFile,
  bundle,
  bundleFile,
  fileSystem = fs
}) {
  const finalPath = requireAbsoluteFile(
    reportFile,
    "social_evidence_report_path_invalid"
  );
  if (path.extname(finalPath).toLowerCase() !== ".json") {
    fail("social_evidence_report_path_invalid");
  }
  const directoryBinding = assertProtectedDirectory(
    path.dirname(finalPath),
    fileSystem
  );
  const reportBytes = Buffer.from(
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  const reportSha256 = crypto
    .createHash("sha256")
    .update(reportBytes)
    .digest("hex");
  const sidecarPath = `${finalPath}.sha256`;
  const sidecarBytes = Buffer.from(
    `${reportSha256}  ${path.basename(finalPath)}\n`,
    "ascii"
  );
  let reportPublication;
  let sidecarPublication;
  try {
    reportPublication = publishExclusiveFile(
      finalPath,
      reportBytes,
      directoryBinding,
      fileSystem
    );
    fsyncDirectory(directoryBinding, fileSystem);
    const rehashed = hashStableFile(finalPath, {
      fileSystem,
      expectedIdentity: reportPublication.stableIdentity,
      code: "social_evidence_report_rehash_failed"
    });
    if (
      rehashed.size !== reportBytes.length ||
      rehashed.sha256 !== reportSha256
    ) {
      fail("social_evidence_report_rehash_failed");
    }
    sidecarPublication = publishExclusiveFile(
      sidecarPath,
      sidecarBytes,
      directoryBinding,
      fileSystem
    );
    fsyncDirectory(directoryBinding, fileSystem);
    const finalReport = hashStableFile(finalPath, {
      fileSystem,
      expectedIdentity: reportPublication.stableIdentity,
      code: "social_evidence_report_final_hash_failed"
    });
    if (
      finalReport.size !== reportBytes.length ||
      finalReport.sha256 !== reportSha256
    ) {
      fail("social_evidence_report_final_hash_failed");
    }
    const sidecar = readStableFile(sidecarPath, {
      fileSystem,
      maximumBytes: 256,
      code: "social_evidence_sidecar_invalid",
      expectedIdentity: sidecarPublication.stableIdentity
    });
    try {
      if (!sidecar.equals(sidecarBytes)) {
        fail("social_evidence_sidecar_invalid");
      }
    } finally {
      sidecar.fill(0);
    }
    const finalBundle = hashStableFile(bundleFile, {
      fileSystem,
      namePattern: SAFE_BUNDLE_NAME,
      expectedIdentity: bundle.identity,
      code: "social_evidence_bundle_final_hash_failed"
    });
    if (
      finalBundle.size !== bundle.size ||
      finalBundle.sha256 !== bundle.sha256
    ) {
      fail("social_evidence_bundle_final_hash_failed");
    }
    fsyncDirectory(directoryBinding, fileSystem);
    assertDirectoryIdentity(directoryBinding, fileSystem);
    const finalReportIdentity = fileSystem.lstatSync(finalPath);
    const finalSidecarIdentity = fileSystem.lstatSync(sidecarPath);
    const finalBundleIdentity = fileSystem.lstatSync(bundleFile);
    if (
      !sameStableIdentity(
        reportPublication.stableIdentity,
        finalReportIdentity
      ) ||
      !sameStableIdentity(
        sidecarPublication.stableIdentity,
        finalSidecarIdentity
      ) ||
      !sameStableIdentity(bundle.identity, finalBundleIdentity)
    ) {
      fail("social_evidence_final_identity_changed");
    }
    return Object.freeze({
      reportFile: finalPath,
      sidecarFile: sidecarPath,
      reportSha256,
      reportFileFsyncConfirmed: true,
      reportDirectoryFsyncConfirmed: true,
      sidecarFileFsyncConfirmed: true,
      sidecarDirectoryFsyncConfirmed: true,
      finalReportHashVerified: true,
      finalBundleHashVerified: true
    });
  } catch (error) {
    let cleanupConfirmed = true;
    let directoryCurrent = true;
    try {
      assertDirectoryIdentity(directoryBinding, fileSystem);
    } catch {
      directoryCurrent = false;
      cleanupConfirmed = false;
    }
    if (directoryCurrent && sidecarPublication) {
      cleanupConfirmed =
        removeOwnedFile(
          sidecarPath,
          sidecarPublication.ownedIdentity,
          fileSystem
        ) && cleanupConfirmed;
      try {
        fsyncDirectory(directoryBinding, fileSystem);
      } catch {
        cleanupConfirmed = false;
      }
    }
    if (directoryCurrent && reportPublication) {
      cleanupConfirmed =
        removeOwnedFile(
          finalPath,
          reportPublication.ownedIdentity,
          fileSystem
        ) && cleanupConfirmed;
      try {
        fsyncDirectory(directoryBinding, fileSystem);
      } catch {
        cleanupConfirmed = false;
      }
    }
    if (!cleanupConfirmed) {
      fail("social_evidence_report_cleanup_failed");
    }
    throw error;
  } finally {
    reportBytes.fill(0);
    sidecarBytes.fill(0);
  }
}

function createDurableEvidenceReport({
  backupFile,
  createFile,
  restoreFile,
  dropFile,
  bundleFile,
  reportFile,
  currentIdentity,
  completedAt = new Date(),
  fileSystem = fs
}) {
  const backup = readSafeJsonEvidence(
    backupFile,
    "backup",
    fileSystem
  );
  const create = readSafeJsonEvidence(
    createFile,
    "create",
    fileSystem
  );
  const restore = readSafeJsonEvidence(
    restoreFile,
    "restore",
    fileSystem
  );
  const drop = readSafeJsonEvidence(dropFile, "drop", fileSystem);
  const bundle = hashStableBundle(bundleFile, fileSystem);
  const report = buildDurableEvidenceReport({
    backup,
    create,
    restore,
    drop,
    bundle,
    currentIdentity,
    completedAt
  });
  return Object.freeze({
    report,
    publication: publishDurableEvidenceReport({
      report,
      reportFile,
      bundle,
      bundleFile,
      fileSystem
    })
  });
}

module.exports = {
  CHECKPOINT,
  LEGACY_2A_COMMIT,
  REPORT_FORMAT,
  REPORT_FORMAT_VERSION,
  SocialBackupEvidenceReportError,
  buildDurableEvidenceReport,
  createDurableEvidenceReport,
  hashStableBundle,
  normalizeBackup,
  normalizeCreate,
  normalizeDrop,
  normalizeRestore,
  publishDurableEvidenceReport,
  readSafeJsonEvidence
};
