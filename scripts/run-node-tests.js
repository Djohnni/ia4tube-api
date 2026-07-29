"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testsDirectory = path.resolve(__dirname, "..", "tests");
const testFiles = fs
  .readdirSync(testsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(testsDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  process.stderr.write("Nenhum teste automatizado foi encontrado.\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
  stdio: "inherit"
});

if (result.error) {
  process.stderr.write("Nao foi possivel iniciar os testes automatizados.\n");
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
