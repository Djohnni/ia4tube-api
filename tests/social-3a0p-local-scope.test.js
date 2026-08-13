"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AUTHORIZED_BRANCH,
  ALLOWED_EXACT_FILES,
  ALLOWED_PREFIXES,
  ROUTE_BASE_COMMIT,
  assertHarnessOnlyChangedFiles,
  isHarnessOnlyFile,
  normalizeRepositoryFile
} = require("../scripts/social-3a0p-local-scope");

const AUTHORIZED_FILES = Object.freeze([
  ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
  "scripts/run-node-tests.js",
  "scripts/social-3a0p-local-scope.js",
  "scripts/social-3b0-linux-physical-gate.js",
  "tests/node-test-runner-safety.test.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-3b0-linux-workflow.test.js"
]);

test("Windows native process serialization scope accepts exactly nine paths", () => {
  assert.equal(
    AUTHORIZED_BRANCH,
    "social/checkpoint-3b0-windows-native-process-serialization-20260813"
  );
  assert.equal(
    ROUTE_BASE_COMMIT,
    "1eae6c50003c523ad80a473a5554eb9f84770389"
  );
  assert.equal(AUTHORIZED_FILES.length, 9);
  assert.deepEqual(ALLOWED_PREFIXES, []);
  assert.deepEqual(
    [...ALLOWED_EXACT_FILES].sort(),
    [...AUTHORIZED_FILES].sort()
  );
  assert.equal(ALLOWED_EXACT_FILES.size, 9);
  for (const file of AUTHORIZED_FILES) {
    assert.equal(isHarnessOnlyFile(file), true, file);
  }
  assert.deepEqual(assertHarnessOnlyChangedFiles([...AUTHORIZED_FILES]), {
    harnessOnly: true,
    changedFileCount: 9
  });
  for (const candidate of [
    AUTHORIZED_FILES.slice(0, 2),
    AUTHORIZED_FILES.slice(0, 6),
    AUTHORIZED_FILES.slice(0, -1)
  ]) {
    assert.throws(() => assertHarnessOnlyChangedFiles(candidate), {
      code: "harness_scope_inventory_refused"
    });
  }
  assert.throws(
    () => assertHarnessOnlyChangedFiles([
      ...AUTHORIZED_FILES,
      AUTHORIZED_FILES[0]
    ]),
    { code: "harness_scope_duplicate_refused" }
  );
  assert.throws(
    () => assertHarnessOnlyChangedFiles([
      ...AUTHORIZED_FILES,
      "tests/tenth-path.test.js"
    ]),
    { code: "harness_scope_product_change_refused" }
  );
});

test("Windows native process serialization scope refuses variants, globs, subpaths and case changes", () => {
  for (const file of [
    ".github/workflows/social-3b0-instagram-oauth-local-contract.yml.bak",
    ".github/workflows/SOCIAL-3B0-INSTAGRAM-OAUTH-LOCAL-CONTRACT.YML",
    ".github/workflows/*.yml",
    "scripts/run-node-tests.js.bak",
    "scripts/RUN-NODE-TESTS.JS",
    "scripts/social-3b0-*.js",
    "scripts/social-3a0p-linux-physical-gates.js.bak",
    "scripts/subdir/social-3a0p-linux-physical-gates.js",
    "scripts/social-3b0-linux-physical-gate.js.bak",
    "scripts/subdir/social-3b0-linux-physical-gate.js",
    "tests/social-3a0p-linux-physical-gates.test.js.bak",
    "tests/SOCIAL-3A0P-LINUX-PHYSICAL-GATES.TEST.JS",
    "tests/subdir/social-3a0p-linux-physical-gates.test.js",
    "tests/social-3b0-linux-physical-gate.test.js.bak",
    "tests/subdir/social-3b0-linux-workflow.test.js",
    "tests/SOCIAL-3B0-LINUX-WORKFLOW.TEST.JS"
  ]) {
    assert.equal(isHarnessOnlyFile(file), false, file);
    assert.throws(() => assertHarnessOnlyChangedFiles([file]), {
      code: "harness_scope_product_change_refused"
    });
  }
});

test("Windows native process serialization scope refuses product, dependency and historical paths", () => {
  for (const file of [
    "server.js",
    "src/social/oauth/instagram-config.js",
    "src/social/oauth/instagram-oauth-router.js",
    "src/social/oauth/instagram-oauth-service.js",
    "src/social/oauth/instagram-provider.js",
    "src/social/oauth/instagram-state-envelope.js",
    "src/social/identity.js",
    "src/social/vault.js",
    "src/social/connectors/service.js",
    "src/persistence/postgres/social-repository.js",
    "src/persistence/postgres/social-connector-store.js",
    "db/migrations/0004_social_connector_persistence.up.sql",
    "migrations/0005_social_oauth.sql",
    "db/postgres/roles.sql",
    "package.json",
    "package-lock.json",
    "docs/social-3b0-instagram-oauth-local-contract.md",
    ".github/workflows/social-3a0p-linux-physical-gates.yml",
    "docs/social-3a0p-linux-physical-gates.md",
    "scripts/social-3a0p-linux-physical-gates.js",
    "tests/social-3a0p-linux-physical-gates.test.js",
    "tests/social-3a0p-linux-workflow.test.js",
    "tests/social-3b0-instagram-oauth-crypto-provider.test.js",
    "tests/social-3b0-instagram-oauth-routes.test.js",
    "app.html"
  ]) {
    assert.equal(isHarnessOnlyFile(file), false, file);
    assert.throws(
      () => assertHarnessOnlyChangedFiles([
        "scripts/social-3a0p-local-scope.js",
        file
      ]),
      { code: "harness_scope_product_change_refused" }
    );
  }
});

test("Windows native process serialization scope rejects traversal and absolute paths", () => {
  for (const file of [
    "../scripts/social-3b0-linux-physical-gate.js",
    "tests/../scripts/social-3b0-linux-physical-gate.js",
    "C:/repo/scripts/social-3b0-linux-physical-gate.js",
    "/repo/scripts/social-3b0-linux-physical-gate.js",
    "./tests/social-3b0-linux-workflow.test.js",
    "tests//social-3b0-linux-workflow.test.js"
  ]) {
    assert.throws(() => normalizeRepositoryFile(file), {
      code: "harness_scope_file_invalid"
    });
  }
});

test("Windows native process serialization scope normalizes only path separators", () => {
  const windowsPath = "scripts\\social-3b0-linux-physical-gate.js";
  assert.equal(
    normalizeRepositoryFile(windowsPath),
    "scripts/social-3b0-linux-physical-gate.js"
  );
  assert.equal(isHarnessOnlyFile(windowsPath), true);
  assert.throws(() => assertHarnessOnlyChangedFiles([windowsPath]), {
    code: "harness_scope_inventory_refused"
  });
});

test("Windows native process serialization scope has no wildcard or directory-wide exception", () => {
  assert.equal(
    [...ALLOWED_EXACT_FILES].some(
      (file) => file.includes("*") || file.endsWith("/")
    ),
    false
  );
  assert.equal(ALLOWED_PREFIXES.length, 0);
});
