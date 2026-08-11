"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ALLOWED_EXACT_FILES,
  assertHarnessOnlyChangedFiles,
  isHarnessOnlyFile,
  normalizeRepositoryFile
} = require("../scripts/social-3a0p-local-scope");

test("checkpoint scope accepts harness files and the two exact authorized sources", () => {
  const files = [
    "scripts/social-3a0p-local-harness-core.js",
    "src/persistence/postgres/backup-restore.js",
    "src/persistence/postgres/restore-behavior-verifiers.js",
    "tests/social-3a0p-local-harness.test.js",
    "docs/social-3a0p-local-physical-harness.md",
    "tests/social-postgres-backup-restore.test.js",
    "tests/social-postgres-migrations.test.js",
    "tests/social-postgres-restore-behavior-verifiers.test.js",
    "tests/social-postgres-real.test.js"
  ];
  assert.deepEqual(assertHarnessOnlyChangedFiles(files), {
    harnessOnly: true,
    changedFileCount: files.length
  });
});

test("non-harness PostgreSQL test exceptions are confined to three exact paths", () => {
  for (const file of [
    "tests/social-postgres-backup-restore.test.js",
    "tests/social-postgres-migrations.test.js",
    "tests/social-postgres-restore-behavior-verifiers.test.js"
  ]) {
    assert.equal(isHarnessOnlyFile(file), true);
    assert.deepEqual(assertHarnessOnlyChangedFiles([file]), {
      harnessOnly: true,
      changedFileCount: 1
    });
  }
  for (const file of [
    "tests/social-postgres-backup-restore-copy.test.js",
    "tests/social-postgres-migration.test.js",
    "tests/social-postgres-restore-behavior-verifier.test.js",
    "tests/social-postgres-other.test.js",
    "tests/subdir/social-postgres-backup-restore.test.js"
  ]) {
    assert.equal(isHarnessOnlyFile(file), false);
    assert.throws(() => assertHarnessOnlyChangedFiles([file]), {
      code: "harness_scope_product_change_refused"
    });
  }
});

test("source exceptions are confined to the two exact authorized product paths", () => {
  for (const source of [
    "src/persistence/postgres/backup-restore.js",
    "src/persistence/postgres/restore-behavior-verifiers.js"
  ]) {
    assert.equal(isHarnessOnlyFile(source), true);
    assert.deepEqual(assertHarnessOnlyChangedFiles([source]), {
      harnessOnly: true,
      changedFileCount: 1
    });
  }
  for (const file of [
    "src/persistence/postgres/backup-restore.js.bak",
    "src/persistence/postgres/backup_restore.js",
    "src/persistence/postgres/restore-behavior-verifiers.js.bak",
    "src/persistence/postgres/subdir/backup-restore.js",
    "src/PERSISTENCE/postgres/backup-restore.js"
  ]) {
    assert.equal(isHarnessOnlyFile(file), false);
    assert.throws(() => assertHarnessOnlyChangedFiles([file]), {
      code: "harness_scope_product_change_refused"
    });
  }
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

test("test runner maintenance scope is confined to two exact files", async (t) => {
  const contracts = Object.freeze([
    Object.freeze(["scripts/run-node-tests.js", "allowed"]),
    Object.freeze(["tests/node-test-runner-safety.test.js", "allowed"]),
    Object.freeze(["scripts/run-node-test.js", "refused"]),
    Object.freeze(["scripts/run-node-tests.js.bak", "refused"]),
    Object.freeze(["scripts/subdir/run-node-tests.js", "refused"]),
    Object.freeze(["tests/node-test-runner-safety.test.js.bak", "refused"]),
    Object.freeze(["tests/subdir/node-test-runner-safety.test.js", "refused"]),
    Object.freeze(["tests/other-existing.test.js", "refused"]),
    Object.freeze(["scripts/", "refused"]),
    Object.freeze(["tests/", "refused"]),
    Object.freeze(["scripts/*", "refused"]),
    Object.freeze(["tests/*", "refused"]),
    Object.freeze(["C:/repo/scripts/run-node-tests.js", "invalid"]),
    Object.freeze(["scripts/../run-node-tests.js", "invalid"]),
    Object.freeze(["scripts\\run-node-tests.js", "allowed"]),
    Object.freeze(["tests\\node-test-runner-safety.test.js", "allowed"])
  ]);

  assert.equal(contracts.length, 16);
  for (const [file, expectation] of contracts) {
    await t.test(`${expectation}: ${file}`, () => {
      if (expectation === "allowed") {
        assert.equal(isHarnessOnlyFile(file), true);
        assert.deepEqual(assertHarnessOnlyChangedFiles([file]), {
          harnessOnly: true,
          changedFileCount: 1
        });
        return;
      }
      if (expectation === "invalid") {
        assert.throws(() => normalizeRepositoryFile(file), {
          code: "harness_scope_file_invalid"
        });
        return;
      }
      assert.equal(isHarnessOnlyFile(file), false);
      assert.throws(() => assertHarnessOnlyChangedFiles([file]), {
        code: "harness_scope_product_change_refused"
      });
    });
  }

  for (const file of [
    "scripts/run-node-tests.js",
    "tests/node-test-runner-safety.test.js"
  ]) {
    assert.equal(ALLOWED_EXACT_FILES.has(file), true);
  }
  assert.deepEqual([...ALLOWED_EXACT_FILES].sort(), [
    ".github/workflows/social-3a0p-linux-physical-gates.yml",
    "scripts/run-node-tests.js",
    "src/persistence/postgres/backup-restore.js",
    "src/persistence/postgres/restore-behavior-verifiers.js",
    "tests/node-test-runner-safety.test.js",
    "tests/social-postgres-backup-restore.test.js",
    "tests/social-postgres-migrations.test.js",
    "tests/social-postgres-real.test.js",
    "tests/social-postgres-restore-behavior-verifiers.test.js"
  ]);
  assert.equal(
    [...ALLOWED_EXACT_FILES].some((file) => file.includes("*")),
    false
  );
  assert.equal(isHarnessOnlyFile("tests/node-test-runner-safety-copy.test.js"), false);
});
