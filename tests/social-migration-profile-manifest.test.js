"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const migrations = require("../src/persistence/postgres/migrations");
const {
  PROFILE_VERSIONS,
  materializeAuthenticatedMigrationProfile
} = require("../scripts/social-migration-profile-manifest");

const repositoryRoot = path.resolve(__dirname, "..");

function ownedFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-migration-profile-"));
}

test("authenticated profile manifests freeze the exact canonical 0003, 0004 and 0005 prefixes", () => {
  const ownedRoot = ownedFixture();
  try {
    for (const [profileId, expectedVersions] of Object.entries(PROFILE_VERSIONS)) {
      const materialized = materializeAuthenticatedMigrationProfile({
        repositoryRoot,
        ownedRoot,
        profileId
      });
      assert.equal(path.dirname(materialized.migrationsDirectory), ownedRoot);
      const manifest = migrations.readManifest(materialized);
      assert.deepEqual(manifest.map((entry) => entry.version), expectedVersions);
      assert.equal(manifest.length, expectedVersions.length);
    }
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test("a selected historic profile ignores an authenticated future migration", () => {
  const ownedRoot = ownedFixture();
  const canonical = migrations.readManifest({ root: repositoryRoot });
  const future = Object.freeze({
    version: "0006_synthetic_future",
    file: "0006_synthetic_future.up.sql",
    sha256: "f".repeat(64),
    sql: "SELECT 1;"
  });
  const migrationsModule = {
    ...migrations,
    readManifest(options) {
      return options.root
        ? Object.freeze([...canonical, future])
        : migrations.readManifest(options);
    }
  };
  try {
    const materialized = materializeAuthenticatedMigrationProfile({
      repositoryRoot,
      ownedRoot,
      profileId: migrations.EXACT_TO_PROFILE,
      migrationsModule
    });
    assert.deepEqual(
      migrations.readManifest(materialized).map((entry) => entry.version),
      migrations.EXACT_TARGET_MIGRATIONS
    );
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test("materialization refuses an unknown profile and preserves a tampered existing profile for evidence", () => {
  const ownedRoot = ownedFixture();
  try {
    assert.throws(
      () => materializeAuthenticatedMigrationProfile({
        repositoryRoot,
        ownedRoot,
        profileId: "social-schema-9999"
      }),
      { code: "migration_profile_materialization_invalid" }
    );
    const materialized = materializeAuthenticatedMigrationProfile({
      repositoryRoot,
      ownedRoot,
      profileId: migrations.EXACT_TO_PROFILE
    });
    const manifest = migrations.readManifest(materialized);
    fs.appendFileSync(
      path.join(materialized.migrationsDirectory, manifest[0].file),
      "\n-- synthetic tamper\n"
    );
    assert.throws(
      () => materializeAuthenticatedMigrationProfile({
        repositoryRoot,
        ownedRoot,
        profileId: migrations.EXACT_TO_PROFILE
      }),
      { code: "migration_checksum_mismatch" }
    );
    assert.equal(fs.existsSync(materialized.migrationsDirectory), true);
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test("a failed new materialization removes only its owned partial directory", () => {
  const ownedRoot = ownedFixture();
  let copies = 0;
  const failure = Object.assign(new Error("synthetic copy failure"), {
    code: "synthetic_profile_copy_failure"
  });
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "copyFileSync") {
        return (...args) => {
          copies += 1;
          if (copies === 2) throw failure;
          return fs.copyFileSync(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  try {
    assert.throws(
      () => materializeAuthenticatedMigrationProfile({
        repositoryRoot,
        ownedRoot,
        profileId: migrations.EXACT_TO_PROFILE,
        fileSystem
      }),
      (error) => error === failure
    );
    assert.equal(
      fs.existsSync(path.join(ownedRoot, "migration-profile-0004")),
      false
    );
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});
