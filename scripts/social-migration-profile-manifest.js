"use strict";

const fs = require("node:fs");
const path = require("node:path");
const migrations = require("../src/persistence/postgres/migrations");

const PROFILE_VERSIONS = Object.freeze({
  [migrations.EXACT_FROM_PROFILE]: migrations.EXACT_BASE_MIGRATIONS,
  [migrations.EXACT_TO_PROFILE]: migrations.EXACT_TARGET_MIGRATIONS,
  [migrations.REFERENCE_CHECK_TO_PROFILE]:
    migrations.REFERENCE_CHECK_TARGET_MIGRATIONS,
  [migrations.COMPLIANCE_TO_PROFILE]:
    migrations.COMPLIANCE_TARGET_MIGRATIONS
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactArrayMatches(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function materializeAuthenticatedMigrationProfile(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const migrationsModule = options.migrationsModule || migrations;
  const repositoryRootInput = options.repositoryRoot;
  const ownedRootInput = options.ownedRoot;
  const repositoryRoot = path.resolve(String(repositoryRootInput || ""));
  const ownedRoot = path.resolve(String(ownedRootInput || ""));
  const profileId = String(options.profileId || "");
  const expectedVersions = PROFILE_VERSIONS[profileId];
  if (
    !expectedVersions ||
    typeof repositoryRootInput !== "string" ||
    repositoryRootInput.length === 0 ||
    typeof ownedRootInput !== "string" ||
    ownedRootInput.length === 0 ||
    !path.isAbsolute(repositoryRoot) ||
    !path.isAbsolute(ownedRoot) ||
    !fileSystem.existsSync(ownedRoot)
  ) {
    fail("migration_profile_materialization_invalid");
  }

  const suffix = profileId.slice(-4);
  const directory = path.join(ownedRoot, `migration-profile-${suffix}`);
  if (
    path.dirname(directory) !== ownedRoot ||
    path.basename(directory) !== `migration-profile-${suffix}`
  ) {
    fail("migration_profile_materialization_path_invalid");
  }

  const authenticatedManifest = migrationsModule.readManifest({
    root: repositoryRoot
  });
  const prefix = authenticatedManifest.slice(0, expectedVersions.length);
  if (
    !exactArrayMatches(
      prefix.map((entry) => entry.version),
      expectedVersions
    )
  ) {
    fail("migration_profile_materialization_manifest_invalid");
  }

  const manifestPath = path.join(directory, "checksums.json");
  let createdByThisCall = false;
  try {
    if (!fileSystem.existsSync(directory)) {
      fileSystem.mkdirSync(directory, { recursive: false });
      createdByThisCall = true;
      for (const entry of prefix) {
        fileSystem.copyFileSync(
          path.join(repositoryRoot, "db", "migrations", entry.file),
          path.join(directory, entry.file),
          fs.constants.COPYFILE_EXCL
        );
      }
      fileSystem.writeFileSync(
        manifestPath,
        `${JSON.stringify({
          format: 1,
          migrations: prefix.map(({ version, file, sha256 }) => ({
            version,
            file,
            sha256
          }))
        }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" }
      );
    }

    const materialized = migrationsModule.readManifest({
      migrationsDirectory: directory,
      manifestPath
    });
    if (
      !exactArrayMatches(
        materialized.map((entry) => entry.version),
        expectedVersions
      ) ||
      materialized.some(
        (entry, index) => entry.sha256 !== prefix[index].sha256
      )
    ) {
      fail("migration_profile_materialization_verification_failed");
    }

    return Object.freeze({ migrationsDirectory: directory, manifestPath });
  } catch (primaryFailure) {
    if (createdByThisCall) {
      try {
        fileSystem.rmSync(directory, { recursive: true, force: false });
      } catch {
        // The materialization failure remains the primary, stable cause.
      }
    }
    throw primaryFailure;
  }
}

module.exports = {
  PROFILE_VERSIONS,
  materializeAuthenticatedMigrationProfile
};
