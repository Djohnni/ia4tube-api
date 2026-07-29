"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testsDirectory = path.resolve(__dirname, "..", "tests");
const DEDICATED_GATE_TEST_FILES = new Set([
  "social-postgres-real.test.js"
]);

function discoverAutomatedTests(directory = testsDirectory) {
  return fs
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

function main() {
  const testFiles = discoverAutomatedTests();
  if (testFiles.length === 0) {
    process.stderr.write("Nenhum teste automatizado foi encontrado.\n");
    return 1;
  }

  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    stdio: "inherit"
  });

  if (result.error) {
    process.stderr.write("Nao foi possivel iniciar os testes automatizados.\n");
    return 1;
  }

  return result.status === null ? 1 : result.status;
}

if (require.main === module) process.exit(main());

module.exports = {
  DEDICATED_GATE_TEST_FILES,
  discoverAutomatedTests,
  main
};
