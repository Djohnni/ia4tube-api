"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  assertHarnessOnlyChangedFiles
} = require("../scripts/social-3a0p-local-scope");

const BASE_COMMIT = "33e3ea7abcea7f5dc51780c3a1efd4743352fe40";
const AUTHORIZED_CHANGED_FILES = Object.freeze([
  ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
  "docs/social-3b0-instagram-oauth-local-contract.md",
  "scripts/social-3a0p-local-scope.js",
  "scripts/social-3b0-linux-physical-gate.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-linux-workflow.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-3b0-linux-workflow.test.js"
]);
const AUTHORIZED_PRODUCT_FILES = Object.freeze([]);
const ROOT = path.resolve(__dirname, "..");

function gitLines(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined, "git read-only deve iniciar");
  assert.equal(result.signal, null, "git read-only nao pode expirar");
  assert.equal(result.status, 0, "git read-only deve concluir");
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

test("o segundo commit OAuth 3B-0 contem exatamente os nove caminhos de infraestrutura", () => {
  const changed = gitLines(["diff", "--name-only", BASE_COMMIT]);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
  const files = [...new Set([...changed, ...untracked])].sort();
  assert.deepEqual(files, [...AUTHORIZED_CHANGED_FILES].sort());
  assert.deepEqual(assertHarnessOnlyChangedFiles(files), {
    harnessOnly: true,
    changedFileCount: 9
  });
});

test("nenhum caminho de produto difere da base funcional 33e3", () => {
  const productPaths = [
    "src",
    "db",
    "migrations",
    "roles.sql",
    "server.js",
    "package.json",
    "package-lock.json"
  ];
  const trackedProduct = gitLines([
    "diff",
    "--name-only",
    BASE_COMMIT,
    "--",
    ...productPaths
  ]);
  const untrackedProduct = gitLines([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ...productPaths
  ]);
  const productDiff = [
    ...new Set([...trackedProduct, ...untrackedProduct])
  ].sort();
  assert.deepEqual(productDiff, [...AUTHORIZED_PRODUCT_FILES].sort());
});
