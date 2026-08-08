"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TOP_LEVEL_KEYS = Object.freeze([
  "cleanupCompleted",
  "cleanupResiduals",
  "directoryFsyncProved",
  "durability",
  "filesystem",
  "noFollow",
  "noFollowProved",
  "ok",
  "schemaVersion",
  "symlinkAttackRejected"
]);
const DURABILITY_KEYS = Object.freeze([
  "atomicRename",
  "createExclusive",
  "directoryFsync",
  "fileClosedBeforeRename",
  "fileFsync",
  "fullWrite",
  "parentDirectoryClosed",
  "parentDirectoryOpened",
  "reopenedNoFollow",
  "sha256Match"
]);
const NOFOLLOW_KEYS = Object.freeze([
  "errorCodesSanitized",
  "everyComponentProtected",
  "finalSymlinkRejected",
  "intermediateSymlinkRejected",
  "neverTraversed",
  "regularFileAccepted",
  "supported",
  "swappedBeforeOpenSymlinkRejected"
]);
const FILESYSTEM_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;
const DURABLE_FILESYSTEMS = new Set(["ext2-ext3", "xfs", "btrfs"]);

class Social3A0PLinuxDurabilityError extends Error {
  constructor(code = "social_3a0p_linux_durability_failed") {
    super(code);
    this.name = "Social3A0PLinuxDurabilityError";
    this.code = code;
  }
}

function fail(code = "social_3a0p_linux_durability_failed") {
  throw new Social3A0PLinuxDurabilityError(code);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function allExactTrue(value, expected) {
  return (
    hasExactKeys(value, expected) &&
    expected.every((key) => value[key] === true)
  );
}

function validateProofShape(result) {
  if (
    !hasExactKeys(result, TOP_LEVEL_KEYS) ||
    result.ok !== true ||
    result.schemaVersion !== 1 ||
    result.directoryFsyncProved !== true ||
    result.noFollowProved !== true ||
    result.symlinkAttackRejected !== true ||
    result.cleanupCompleted !== true ||
    result.cleanupResiduals !== 0 ||
    !FILESYSTEM_PATTERN.test(result.filesystem || "") ||
    !DURABLE_FILESYSTEMS.has(result.filesystem) ||
    !allExactTrue(result.durability, DURABILITY_KEYS) ||
    !allExactTrue(result.noFollow, NOFOLLOW_KEYS)
  ) {
    fail("social_3a0p_linux_durability_evidence_invalid");
  }
  return result;
}

function runLinuxDurabilityProof({
  runnerTemp,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  pythonExecutable = "python3"
} = {}) {
  if (
    platform !== "linux" ||
    typeof runnerTemp !== "string" ||
    !path.isAbsolute(runnerTemp) ||
    path.normalize(runnerTemp) !== runnerTemp ||
    typeof spawnSyncImpl !== "function" ||
    pythonExecutable !== "python3"
  ) {
    fail("social_3a0p_linux_durability_precondition_invalid");
  }

  const script = path.join(__dirname, "social-3a0p-linux-durability.py");
  let completed;
  try {
    completed = spawnSyncImpl(pythonExecutable, [script], {
      input: JSON.stringify({ runnerTemp }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin"
      }
    });
  } catch {
    fail();
  }

  if (
    !completed ||
    completed.error ||
    completed.signal ||
    completed.status !== 0 ||
    typeof completed.stdout !== "string" ||
    completed.stdout.length > 32 * 1024 ||
    typeof completed.stderr !== "string" ||
    completed.stderr !== ""
  ) {
    fail();
  }

  let result;
  try {
    const trimmed = completed.stdout.trim();
    if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) fail();
    result = JSON.parse(trimmed);
  } catch (error) {
    if (error instanceof Social3A0PLinuxDurabilityError) throw error;
    fail();
  }
  return validateProofShape(result);
}

module.exports = {
  DURABILITY_KEYS,
  DURABLE_FILESYSTEMS,
  NOFOLLOW_KEYS,
  Social3A0PLinuxDurabilityError,
  TOP_LEVEL_KEYS,
  runLinuxDurabilityProof,
  validateProofShape
};
