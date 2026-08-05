"use strict";

const path = require("node:path");

const ALLOWED_EXACT_FILES = new Set([
  "tests/social-postgres-real.test.js"
]);
const ALLOWED_PREFIXES = Object.freeze([
  "scripts/social-3a0p-",
  "tests/social-3a0p-",
  "docs/social-3a0p-"
]);
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
  if (normalized.some((file) => !isHarnessOnlyFile(file))) {
    refuse("harness_scope_product_change_refused");
  }
  if (
    normalized.some(
      (file) =>
        FORBIDDEN_PRODUCT_FILES.has(file) ||
        FORBIDDEN_PRODUCT_PREFIXES.some((prefix) => file.startsWith(prefix))
    )
  ) {
    refuse("harness_scope_product_change_refused");
  }
  return Object.freeze({
    harnessOnly: true,
    changedFileCount: normalized.length
  });
}

module.exports = {
  ALLOWED_EXACT_FILES,
  ALLOWED_PREFIXES,
  FORBIDDEN_PRODUCT_FILES,
  FORBIDDEN_PRODUCT_PREFIXES,
  HarnessScopeFailure,
  assertHarnessOnlyChangedFiles,
  isHarnessOnlyFile,
  normalizeRepositoryFile
};
