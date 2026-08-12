"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ALLOWED_EXACT_FILES,
  ALLOWED_PREFIXES,
  assertHarnessOnlyChangedFiles,
  isHarnessOnlyFile,
  normalizeRepositoryFile
} = require("../scripts/social-3a0p-local-scope");

const AUTHORIZED_FILES = Object.freeze([
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

test("OAuth 3B-0 scope accepts exactly the eighteen authorized paths", () => {
  assert.equal(AUTHORIZED_FILES.length, 18);
  assert.deepEqual(ALLOWED_PREFIXES, []);
  assert.deepEqual(
    [...ALLOWED_EXACT_FILES].sort(),
    [...AUTHORIZED_FILES].sort()
  );
  assert.equal(ALLOWED_EXACT_FILES.size, 18);
  for (const file of AUTHORIZED_FILES) {
    assert.equal(isHarnessOnlyFile(file), true, file);
  }
  assert.deepEqual(assertHarnessOnlyChangedFiles([...AUTHORIZED_FILES]), {
    harnessOnly: true,
    changedFileCount: 18
  });
});

test("OAuth 3B-0 scope refuses variants, globs, subpaths and case changes", () => {
  for (const file of [
    "server.js.bak",
    "SERVER.js",
    "src/social/oauth/",
    "src/social/oauth/*.js",
    "src/social/oauth/instagram-config.js.bak",
    "src/social/oauth/subdir/instagram-config.js",
    "src/social/oauth/Instagram-config.js",
    "src/social/oauth/instagram-state-envelope.test.js",
    "tests/social-3b0-instagram-oauth-state-envelope.test.js",
    "tests/social-3b0-instagram-oauth-routes.test.js.bak",
    "tests/subdir/social-3b0-instagram-oauth-routes.test.js",
    "tests/SOCIAL-3B0-INSTAGRAM-OAUTH-ROUTES.TEST.JS"
  ]) {
    assert.equal(isHarnessOnlyFile(file), false, file);
    assert.throws(() => assertHarnessOnlyChangedFiles([file]), {
      code: "harness_scope_product_change_refused"
    });
  }
});

test("OAuth 3B-0 scope refuses every product or dependency path outside its allowlist", () => {
  for (const file of [
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
    ".github/workflows/social-3a0p-linux-physical-gates.yml",
    "docs/social-3a0p-linux-physical-gates.md",
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

test("OAuth 3B-0 scope rejects traversal and absolute paths", () => {
  for (const file of [
    "../server.js",
    "tests/../server.js",
    "C:/repo/server.js",
    "/repo/server.js",
    "./tests/social-3b0-instagram-oauth-routes.test.js",
    "tests//social-3b0-instagram-oauth-routes.test.js"
  ]) {
    assert.throws(() => normalizeRepositoryFile(file), {
      code: "harness_scope_file_invalid"
    });
  }
});

test("OAuth 3B-0 scope normalizes only path separators", () => {
  const windowsPath = "src\\social\\oauth\\instagram-config.js";
  assert.equal(
    normalizeRepositoryFile(windowsPath),
    "src/social/oauth/instagram-config.js"
  );
  assert.equal(isHarnessOnlyFile(windowsPath), true);
  assert.deepEqual(assertHarnessOnlyChangedFiles([windowsPath]), {
    harnessOnly: true,
    changedFileCount: 1
  });
});

test("OAuth 3B-0 scope has no wildcard or directory-wide exception", () => {
  assert.equal(
    [...ALLOWED_EXACT_FILES].some(
      (file) => file.includes("*") || file.endsWith("/")
    ),
    false
  );
  assert.equal(ALLOWED_PREFIXES.length, 0);
});
