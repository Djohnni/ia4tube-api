"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const LINUX_PRE_GATE_TEST_FILES = Object.freeze([
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3a0p-linux-pre-gate-tests.test.js",
  "tests/social-3a0p-linux-workflow.test.js",
  "tests/social-3a0p-linux-durability.test.js",
  "tests/social-3a0p-linux-postgres.test.js",
  "tests/social-3a0p-local-connector-physical-gates.test.js",
  "tests/social-3a0p-linux-physical-gates.test.js",
  "tests/social-3a0p-linux-gate.test.js"
]);
const LINUX_PRE_GATE_TEST_FILE_SET = new Set(LINUX_PRE_GATE_TEST_FILES);
const TEST_FILE_PATTERN = /^tests\/[a-z0-9][a-z0-9.-]*\.test\.js$/;

function runnerError(code) {
  return Object.assign(new Error(code), { code });
}

function validateManifestPath(file) {
  if (
    typeof file !== "string" ||
    !file ||
    file.includes("\0") ||
    file.includes("\\") ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    !TEST_FILE_PATTERN.test(file)
  ) {
    throw runnerError("linux_pre_gate_manifest_path_invalid");
  }
  return file;
}

function validateLinuxPreGateManifest(manifest, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = options.repositoryRoot || repositoryRoot;
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw runnerError("linux_pre_gate_manifest_invalid");
  }

  const seen = new Set();
  for (const candidate of manifest) {
    const file = validateManifestPath(candidate);
    if (seen.has(file)) {
      throw runnerError("linux_pre_gate_manifest_duplicate");
    }
    seen.add(file);
  }

  if (manifest.some((file) => !LINUX_PRE_GATE_TEST_FILE_SET.has(file))) {
    throw runnerError("linux_pre_gate_manifest_file_extra");
  }
  if (
    manifest.length !== LINUX_PRE_GATE_TEST_FILES.length ||
    LINUX_PRE_GATE_TEST_FILES.some((file) => !seen.has(file))
  ) {
    throw runnerError("linux_pre_gate_manifest_file_missing");
  }
  if (manifest.some((file, index) => file !== LINUX_PRE_GATE_TEST_FILES[index])) {
    throw runnerError("linux_pre_gate_manifest_order_invalid");
  }

  for (const file of manifest) {
    const absolute = path.resolve(root, ...file.split("/"));
    const relative = path.relative(root, absolute);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw runnerError("linux_pre_gate_manifest_path_invalid");
    }

    let stat;
    try {
      stat = fsImpl.lstatSync(absolute);
    } catch {
      throw runnerError("linux_pre_gate_manifest_file_missing");
    }
    if (
      !stat ||
      typeof stat.isFile !== "function" ||
      !stat.isFile() ||
      (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())
    ) {
      throw runnerError("linux_pre_gate_manifest_file_missing");
    }
  }

  return Object.freeze([...manifest]);
}

function main(options = {}) {
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const fsImpl = options.fsImpl || fs;
  const manifest = options.manifest || LINUX_PRE_GATE_TEST_FILES;
  const root = options.repositoryRoot || repositoryRoot;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const stderr = options.stderr || process.stderr;

  let plan;
  try {
    plan = validateLinuxPreGateManifest(manifest, {
      fsImpl,
      repositoryRoot: root
    });
  } catch {
    stderr.write("Configuracao invalida da suite pre-gate Linux.\n");
    return 1;
  }

  for (const file of plan) {
    let result;
    try {
      result = spawnSyncImpl(execPath, ["--test", file], {
        cwd: root,
        env,
        stdio: "inherit"
      });
    } catch {
      stderr.write("Nao foi possivel iniciar a suite pre-gate Linux.\n");
      return 1;
    }
    if (
      result?.error ||
      !Number.isInteger(result?.status) ||
      (result.signal !== null && result.signal !== undefined)
    ) {
      stderr.write("Nao foi possivel concluir a suite pre-gate Linux.\n");
      return 1;
    }
    if (result.status !== 0) return result.status;
  }

  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  LINUX_PRE_GATE_TEST_FILES,
  main,
  validateLinuxPreGateManifest
};
