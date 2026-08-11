"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  assertHarnessOnlyChangedFiles
} = require("../scripts/social-3a0p-local-scope");

const BASE_COMMIT = "fcfc92419021dae5f77baad731c634b10c275c5b";
const AUTHORIZED_PRODUCT_FILE = "src/persistence/postgres/backup-restore.js";
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
  assert.equal(result.signal, null, "git read-only não pode expirar");
  assert.equal(result.status, 0, "git read-only deve concluir");
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

test("o diff físico atual contém somente o catálogo e o harness autorizados", () => {
  const changed = gitLines(["diff", "--name-only", BASE_COMMIT]);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
  const files = [...new Set([...changed, ...untracked])].sort();
  assert.ok(files.length > 0, "o checkpoint precisa conter seu próprio diff");
  assert.deepEqual(assertHarnessOnlyChangedFiles(files), {
    harnessOnly: true,
    changedFileCount: files.length
  });
});

test("somente o catálogo autorizado difere no produto; o restante permanece na base", () => {
  const productDiff = gitLines([
    "diff",
    "--name-only",
    BASE_COMMIT,
    "--",
    "src",
    "db",
    "migrations",
    "server.js",
    "package.json",
    "package-lock.json"
  ]);
  assert.deepEqual(productDiff, [AUTHORIZED_PRODUCT_FILE]);
});
