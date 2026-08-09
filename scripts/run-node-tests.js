"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const testsDirectory = path.join(repositoryRoot, "tests");
const DEDICATED_GATE_TEST_FILES = new Set([
  "social-postgres-real.test.js"
]);
const PROCESS_LIFECYCLE_TEST_FILES = Object.freeze([
  "body-parser-security.test.js",
  "checkpoint-a-security.test.js",
  "fcm-token-encryption.test.js",
  "social-2b0-config-security.test.js",
  "social-foundation-integration.test.js",
  "zip-downloads.test.js"
]);

function runnerError(code) {
  return Object.assign(new Error(code), { code });
}

function discoverAutomatedTests(directory = testsDirectory, options = {}) {
  const fsImpl = options.fsImpl || fs;
  return fsImpl
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.js") &&
        !DEDICATED_GATE_TEST_FILES.has(entry.name)
    )
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function validateSerialManifest(manifest) {
  const seen = new Set();
  for (const name of manifest) {
    if (seen.has(name)) {
      throw runnerError("test_runner_serial_manifest_duplicate");
    }
    seen.add(name);
  }
}

function validateTestPartition(discovered, serial, concurrent) {
  const concurrentSet = new Set(concurrent);
  if (serial.some((file) => concurrentSet.has(file))) {
    throw runnerError("test_runner_partition_overlap");
  }

  const discoveredSet = new Set(discovered);
  const executionCounts = new Map();
  for (const file of [...serial, ...concurrent]) {
    executionCounts.set(file, (executionCounts.get(file) || 0) + 1);
  }
  if (
    executionCounts.size !== discoveredSet.size ||
    [...discoveredSet].some((file) => executionCounts.get(file) !== 1) ||
    [...executionCounts].some(([file, count]) => !discoveredSet.has(file) || count !== 1)
  ) {
    throw runnerError("test_runner_partition_incomplete");
  }
  return true;
}

function partitionAutomatedTests(
  discovered,
  manifest = PROCESS_LIFECYCLE_TEST_FILES
) {
  validateSerialManifest(manifest);
  const byBasename = new Map(discovered.map((file) => [path.basename(file), file]));
  const serial = manifest.map((name) => {
    const file = byBasename.get(name);
    if (!file) throw runnerError("test_runner_serial_file_missing");
    return file;
  });
  const serialSet = new Set(serial);
  const concurrent = discovered.filter((file) => !serialSet.has(file));
  validateTestPartition(discovered, serial, concurrent);
  return Object.freeze({
    serial: Object.freeze(serial),
    concurrent: Object.freeze(concurrent)
  });
}

function runTestStage(testFiles, options = {}) {
  const args = [
    "--test",
    ...(options.serial ? ["--test-concurrency=1"] : []),
    ...testFiles
  ];
  let result;
  try {
    result = options.spawnSyncImpl(options.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit"
    });
  } catch {
    options.stderr.write("Nao foi possivel iniciar os testes automatizados.\n");
    return 1;
  }
  if (result?.error || !Number.isInteger(result?.status)) {
    options.stderr.write("Nao foi possivel iniciar os testes automatizados.\n");
    return 1;
  }
  return result.status;
}

function main(options = {}) {
  const directory = options.testsDirectory || testsDirectory;
  const fsImpl = options.fsImpl || fs;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const execPath = options.execPath || process.execPath;
  const cwd = options.cwd || repositoryRoot;
  const env = options.env || process.env;
  const stderr = options.stderr || process.stderr;
  const manifest = options.processLifecycleTestFiles || PROCESS_LIFECYCLE_TEST_FILES;
  const testFiles = discoverAutomatedTests(directory, { fsImpl });
  if (testFiles.length === 0) {
    stderr.write("Nenhum teste automatizado foi encontrado.\n");
    return 1;
  }

  let plan;
  try {
    plan = partitionAutomatedTests(testFiles, manifest);
  } catch {
    stderr.write("Configuracao invalida do runner de testes automatizados.\n");
    return 1;
  }

  const stageOptions = {
    cwd,
    env,
    execPath,
    spawnSyncImpl,
    stderr
  };
  const serialStatus = runTestStage(plan.serial, {
    ...stageOptions,
    serial: true
  });
  if (serialStatus !== 0) return serialStatus;
  if (plan.concurrent.length === 0) return 0;
  return runTestStage(plan.concurrent, {
    ...stageOptions,
    serial: false
  });
}

if (require.main === module) process.exit(main());

module.exports = {
  DEDICATED_GATE_TEST_FILES,
  PROCESS_LIFECYCLE_TEST_FILES,
  discoverAutomatedTests,
  main,
  partitionAutomatedTests,
  runTestStage,
  validateTestPartition
};
