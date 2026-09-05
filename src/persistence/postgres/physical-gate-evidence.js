"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("./staging-provisioner");

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INCLUDED_TREES = Object.freeze([
  Object.freeze({ directory: "src/persistence/postgres", extensions: [".js", ".sql"] }),
  Object.freeze({ directory: "src/social", extensions: [".js"] })
]);
const INCLUDED_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/run-real-postgres-tests.js",
  "scripts/social-db-backup-restore-evidence.js",
  "scripts/social-db-backup-restore-linux-gate.js",
  "scripts/social-db-backup-restore.js",
  "scripts/social-db-disposable-lifecycle.js",
  "scripts/social-postgres-sizing.js",
  "scripts/social-runtime-canary-fixture-seed.js"
]);

class SocialPhysicalGateEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "SocialPhysicalGateEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new SocialPhysicalGateEvidenceError(code);
}

function sameStableFile(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs &&
      (left.mode & 0o7777) === (right.mode & 0o7777)
  );
}

function openReadOnlyNoFollow(
  file,
  fileSystem = fs,
  platform = process.platform
) {
  let flags = fs.constants.O_RDONLY;
  if (platform === "linux") {
    if (
      !Number.isSafeInteger(fs.constants.O_NOFOLLOW) ||
      fs.constants.O_NOFOLLOW === 0
    ) {
      fail("physical_evidence_nofollow_unavailable");
    }
    flags |= fs.constants.O_NOFOLLOW;
  }
  try {
    return fileSystem.openSync(file, flags);
  } catch {
    fail("physical_evidence_code_file_invalid");
  }
}

function hashStableCodeFile(
  file,
  fileSystem = fs,
  platform = process.platform
) {
  const before = fileSystem.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail("physical_evidence_code_file_invalid");
  }
  let descriptor;
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const canonical = Buffer.allocUnsafe(1024 * 1024);
  let canonicalSize = 0;
  let pendingCarriageReturn = false;
  try {
    descriptor = openReadOnlyNoFollow(file, fileSystem, platform);
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isFile() || !sameStableFile(before, opened)) {
      fail("physical_evidence_code_file_changed");
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
      let canonicalCount = 0;
      for (let index = 0; index < count; index += 1) {
        const byte = buffer[index];
        if (pendingCarriageReturn) {
          if (byte !== 0x0a) {
            fail("physical_evidence_code_line_ending_invalid");
          }
          canonical[canonicalCount] = 0x0a;
          canonicalCount += 1;
          pendingCarriageReturn = false;
          continue;
        }
        if (byte === 0x0d) {
          pendingCarriageReturn = true;
          continue;
        }
        if (byte === 0x00) {
          fail("physical_evidence_code_file_invalid");
        }
        canonical[canonicalCount] = byte;
        canonicalCount += 1;
      }
      hash.update(canonical.subarray(0, canonicalCount));
      canonicalSize += canonicalCount;
    }
    if (pendingCarriageReturn) {
      fail("physical_evidence_code_line_ending_invalid");
    }
    const after = fileSystem.fstatSync(descriptor);
    if (!sameStableFile(opened, after)) {
      fail("physical_evidence_code_file_changed");
    }
    return Object.freeze({
      size: canonicalSize,
      sha256: hash.digest("hex")
    });
  } finally {
    buffer.fill(0);
    canonical.fill(0);
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function collectTreeFiles(
  root,
  relativeDirectory,
  extensions,
  fileSystem,
  output
) {
  const absolute = path.join(root, relativeDirectory);
  const entries = fileSystem
    .readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      fail("physical_evidence_code_tree_symlink_refused");
    }
    if (entry.isDirectory()) {
      collectTreeFiles(
        root,
        relative,
        extensions,
        fileSystem,
        output
      );
    } else if (
      entry.isFile() &&
      extensions.includes(path.extname(entry.name).toLowerCase())
    ) {
      output.push(relative);
    }
  }
}

function executionCodeManifest({
  repositoryRoot = path.resolve(__dirname, "../../.."),
  fileSystem = fs,
  platform = process.platform
} = {}) {
  const root = path.resolve(repositoryRoot);
  const rootMetadata = fileSystem.lstatSync(root);
  const realRoot = path.resolve(fileSystem.realpathSync(root));
  if (
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory() ||
    realRoot !== root
  ) {
    fail("physical_evidence_repository_root_invalid");
  }
  const relativeFiles = [...INCLUDED_FILES];
  for (const tree of INCLUDED_TREES) {
    collectTreeFiles(
      root,
      tree.directory,
      tree.extensions,
      fileSystem,
      relativeFiles
    );
  }
  relativeFiles.sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(relativeFiles).size !== relativeFiles.length) {
    fail("physical_evidence_code_manifest_invalid");
  }
  const manifest = crypto.createHash("sha256");
  for (const relative of relativeFiles) {
    const metadata = hashStableCodeFile(
      path.join(root, relative),
      fileSystem,
      platform
    );
    manifest.update(relative.replaceAll("\\", "/"), "utf8");
    manifest.update("\0", "utf8");
    manifest.update(String(metadata.size), "ascii");
    manifest.update("\0", "utf8");
    manifest.update(metadata.sha256, "ascii");
    manifest.update("\n", "utf8");
  }
  return Object.freeze({
    fileCount: relativeFiles.length,
    sha256: manifest.digest("hex")
  });
}

function exactText(value, pattern, code) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    fail(code);
  }
  return value;
}

function isoNow(now, code) {
  if (typeof now !== "function") fail(code);
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) fail(code);
  return date.toISOString();
}

function loadExecutionIdentity(
  env = process.env,
  options = {}
) {
  const runId = exactText(
    env.SOCIAL_2B_EVIDENCE_RUN_ID,
    UUID_V4_PATTERN,
    "physical_evidence_run_id_invalid"
  );
  const expectedCommit = exactText(
    env.SOCIAL_2B_EVIDENCE_COMMIT,
    COMMIT_PATTERN,
    "physical_evidence_commit_invalid"
  );
  const renderCommit = exactText(
    env.RENDER_GIT_COMMIT,
    COMMIT_PATTERN,
    "physical_evidence_render_commit_invalid"
  );
  if (expectedCommit !== renderCommit) {
    fail("physical_evidence_render_commit_mismatch");
  }
  const expectedManifestSha256 = exactText(
    env.SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_SHA256,
    SHA256_PATTERN,
    "physical_evidence_expected_manifest_invalid"
  );
  const expectedManifestFileCount = Number(
    exactText(
      env.SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_FILE_COUNT,
      /^[1-9][0-9]{0,3}$/,
      "physical_evidence_expected_manifest_count_invalid"
    )
  );
  const manifest = executionCodeManifest(options);
  if (
    manifest.sha256 !== expectedManifestSha256 ||
    manifest.fileCount !== expectedManifestFileCount
  ) {
    fail("physical_evidence_code_manifest_mismatch");
  }
  return Object.freeze({
    runId,
    commit: renderCommit,
    renderCommitVerified: true,
    codeManifestSha256: manifest.sha256,
    codeManifestFileCount: manifest.fileCount,
    environment: "staging",
    environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
    region: "oregon"
  });
}

function startPhysicalEvidence({
  identity,
  sequence,
  databasePurpose,
  databaseName,
  targetFingerprint,
  now = () => new Date()
}) {
  if (
    !identity ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > 4 ||
    !["primary-backup", "disposable-restore", "disposable-gate"].includes(
      databasePurpose
    ) ||
    !/^[a-z][a-z0-9_]{2,62}$/.test(String(databaseName || "")) ||
    !SHA256_PATTERN.test(String(targetFingerprint || ""))
  ) {
    fail("physical_evidence_step_identity_invalid");
  }
  return Object.freeze({
    ...identity,
    sequence,
    databasePurpose,
    databaseName,
    targetFingerprint,
    startedAt: isoNow(now, "physical_evidence_started_at_invalid")
  });
}

function completePhysicalEvidence(
  started,
  now = () => new Date(),
  options = {}
) {
  const manifestLoader =
    options.manifestLoader || executionCodeManifest;
  const currentManifest = manifestLoader(options);
  if (
    !started ||
    currentManifest?.sha256 !== started.codeManifestSha256 ||
    currentManifest?.fileCount !== started.codeManifestFileCount
  ) {
    fail("physical_evidence_code_changed_during_step");
  }
  const completedAt = isoNow(
    now,
    "physical_evidence_completed_at_invalid"
  );
  if (
    Date.parse(completedAt) < Date.parse(started.startedAt)
  ) {
    fail("physical_evidence_time_order_invalid");
  }
  return Object.freeze({ ...started, completedAt });
}

module.exports = {
  COMMIT_PATTERN,
  INCLUDED_FILES,
  INCLUDED_TREES,
  SHA256_PATTERN,
  UUID_V4_PATTERN,
  SocialPhysicalGateEvidenceError,
  completePhysicalEvidence,
  executionCodeManifest,
  hashStableCodeFile,
  loadExecutionIdentity,
  startPhysicalEvidence
};
