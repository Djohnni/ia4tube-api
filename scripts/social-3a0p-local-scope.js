"use strict";

const path = require("node:path");

const AUTHORIZED_BRANCH =
  "social/checkpoint-3b0-windows-native-process-serialization-20260813";
const ROUTE_BASE_COMMIT = "1eae6c50003c523ad80a473a5554eb9f84770389";

const ALLOWED_EXACT_FILES = new Set([
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
const ALLOWED_PREFIXES = Object.freeze([]);
const FORBIDDEN_PRODUCT_PREFIXES = Object.freeze([
  "src/",
  "db/",
  "migrations/"
]);
const FORBIDDEN_PRODUCT_FILES = new Set([
  "server.js",
  "package.json",
  "package-lock.json"
]);

class HarnessScopeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "HarnessScopeFailure";
  }
}

function refuse(code) {
  throw new HarnessScopeFailure(code);
}

function normalizeRepositoryFile(file) {
  if (typeof file !== "string" || !file || file.includes("\0")) {
    refuse("harness_scope_file_invalid");
  }
  const normalized = file.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    /^[a-z]:\//i.test(normalized) ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..") ||
    normalized.startsWith("./") ||
    normalized.includes("//")
  ) {
    refuse("harness_scope_file_invalid");
  }
  return normalized;
}

function isHarnessOnlyFile(file) {
  const normalized = normalizeRepositoryFile(file);
  return (
    ALLOWED_EXACT_FILES.has(normalized) ||
    ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function assertHarnessOnlyChangedFiles(files) {
  if (!Array.isArray(files) || files.length < 1) {
    refuse("harness_scope_change_list_invalid");
  }
  const normalized = files.map(normalizeRepositoryFile);
  if (new Set(normalized).size !== normalized.length) {
    refuse("harness_scope_duplicate_refused");
  }
  if (normalized.some((file) => !isHarnessOnlyFile(file))) {
    refuse("harness_scope_product_change_refused");
  }
  if (
    normalized.some(
      (file) =>
        !ALLOWED_EXACT_FILES.has(file) &&
        (
          FORBIDDEN_PRODUCT_FILES.has(file) ||
          FORBIDDEN_PRODUCT_PREFIXES.some((prefix) => file.startsWith(prefix))
        )
    )
  ) {
    refuse("harness_scope_product_change_refused");
  }
  if (
    normalized.length !== ALLOWED_EXACT_FILES.size ||
    [...ALLOWED_EXACT_FILES].some((file) => !normalized.includes(file))
  ) {
    refuse("harness_scope_inventory_refused");
  }
  return Object.freeze({
    harnessOnly: true,
    changedFileCount: normalized.length
  });
}

module.exports = {
  AUTHORIZED_BRANCH,
  ALLOWED_EXACT_FILES,
  ALLOWED_PREFIXES,
  FORBIDDEN_PRODUCT_FILES,
  FORBIDDEN_PRODUCT_PREFIXES,
  HarnessScopeFailure,
  ROUTE_BASE_COMMIT,
  assertHarnessOnlyChangedFiles,
  isHarnessOnlyFile,
  normalizeRepositoryFile
};
