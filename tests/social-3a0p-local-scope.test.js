"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertHarnessOnlyChangedFiles,
  isHarnessOnlyFile,
  normalizeRepositoryFile
} = require("../scripts/social-3a0p-local-scope");

test("harness scope accepts only the checkpoint scripts, tests and docs", () => {
  const files = [
    "scripts/social-3a0p-local-harness-core.js",
    "tests/social-3a0p-local-harness.test.js",
    "docs/social-3a0p-local-physical-harness.md",
    "tests/social-postgres-real.test.js"
  ];
  assert.deepEqual(assertHarnessOnlyChangedFiles(files), {
    harnessOnly: true,
    changedFileCount: files.length
  });
});

test("harness scope refuses every product or dependency change", () => {
  for (const file of [
    "src/social/connector.js",
    "db/migrations/0004_social.sql",
    "migrations/0004_social.sql",
    "server.js",
    "package.json",
    "package-lock.json",
    "app.html"
  ]) {
    assert.throws(
      () => assertHarnessOnlyChangedFiles([
        "scripts/social-3a0p-local-harness-core.js",
        file
      ]),
      { code: "harness_scope_product_change_refused" }
    );
  }
});

test("harness scope rejects path traversal and absolute paths", () => {
  for (const file of [
    "../server.js",
    "tests/../server.js",
    "C:/repo/server.js",
    "/repo/server.js",
    "./tests/social-3a0p-local-harness.test.js",
    "tests//social-3a0p-local-harness.test.js"
  ]) {
    assert.throws(() => normalizeRepositoryFile(file), {
      code: "harness_scope_file_invalid"
    });
  }
});

test("surgical loopback test change remains confined to its exact path", () => {
  assert.equal(isHarnessOnlyFile("tests/social-postgres-real.test.js"), true);
  assert.equal(isHarnessOnlyFile("tests/other-existing.test.js"), false);
  assert.equal(isHarnessOnlyFile("scripts/run-real-postgres-tests.js"), false);
});

test("the exact Linux physical-gate workflow is the sole workflow exception", () => {
  const workflow = ".github/workflows/social-3a0p-linux-physical-gates.yml";
  assert.equal(isHarnessOnlyFile(workflow), true);
  assert.deepEqual(assertHarnessOnlyChangedFiles([workflow]), {
    harnessOnly: true,
    changedFileCount: 1
  });

  for (const file of [
    ".github/workflows/",
    ".github/workflows/*",
    ".github/workflows/other.yml",
    ".github/workflows/social-3a0p-linux-physical-gates.yaml",
    ".github/workflows/social-3a0p-linux-physical-gates.yml/other",
    ".github/workflows/SOCIAL-3A0P-LINUX-PHYSICAL-GATES.YML"
  ]) {
    assert.equal(isHarnessOnlyFile(file), false);
    assert.throws(() => assertHarnessOnlyChangedFiles([file]), {
      code: "harness_scope_product_change_refused"
    });
  }
});
