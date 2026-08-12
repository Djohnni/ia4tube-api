"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  assertHarnessOnlyChangedFiles
} = require("../scripts/social-3a0p-local-scope");

const BASE_COMMIT = "3dc3d8be62438216509f061f6c1a26ee39c9b5dc";
const AUTHORIZED_CHANGED_FILES = Object.freeze([
  "scripts/social-3a0p-local-scope.js",
  "server.js",
  "src/persistence/postgres/social-oauth-repository.js",
  "src/social/auth-adapter.js",
  "src/social/credential-service.js",
  "src/social/oauth/instagram-config.js",
  "src/social/oauth/instagram-oauth-router.js",
  "src/social/oauth/instagram-oauth-service.js",
  "src/social/oauth/instagram-provider.js",
  "src/social/oauth/instagram-state-envelope.js",
  "src/social/runtime.js",
  "src/social/server-runtime.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-instagram-oauth-crypto-provider.test.js",
  "tests/social-3b0-instagram-oauth-routes.test.js",
  "tests/social-connector-persistence.test.js",
  "tests/social-server-runtime.test.js"
]);
const AUTHORIZED_PRODUCT_FILES = Object.freeze([
  "server.js",
  "src/persistence/postgres/social-oauth-repository.js",
  "src/social/auth-adapter.js",
  "src/social/credential-service.js",
  "src/social/oauth/instagram-config.js",
  "src/social/oauth/instagram-oauth-router.js",
  "src/social/oauth/instagram-oauth-service.js",
  "src/social/oauth/instagram-provider.js",
  "src/social/oauth/instagram-state-envelope.js",
  "src/social/runtime.js",
  "src/social/server-runtime.js"
]);
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

test("o diff fisico OAuth 3B-0 contem exatamente os dezoito caminhos autorizados", () => {
  const changed = gitLines(["diff", "--name-only", BASE_COMMIT]);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
  const files = [...new Set([...changed, ...untracked])].sort();
  assert.deepEqual(files, [...AUTHORIZED_CHANGED_FILES].sort());
  assert.deepEqual(assertHarnessOnlyChangedFiles(files), {
    harnessOnly: true,
    changedFileCount: 18
  });
});

test("somente os onze caminhos de produto OAuth autorizados diferem da base 3dc3", () => {
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
