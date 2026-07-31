"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createDurableEvidenceReport
} = require(
  "../src/persistence/postgres/durable-evidence-report"
);
const {
  targetFingerprint
} = require("../src/persistence/postgres/backup-restore");
const {
  RESTORE_DISPOSABLE_DATABASE_NAME
} = require(
  "../src/persistence/postgres/disposable-database-lifecycle"
);
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");
const {
  main
} = require("../scripts/social-db-backup-restore-evidence");

const COMMIT = "3204e876401175c37f028eaa8ebbff90c5c909f9";
const RUN_ID = "12345678-1234-4abc-8def-1234567890ab";
const COMPLETED_AT = "2026-07-31T12:08:00.000Z";
const EVIDENCE_SHA256 = "b".repeat(64);
const CODE_MANIFEST_SHA256 = "e".repeat(64);
const CODE_MANIFEST_FILE_COUNT = 42;
const PRIMARY_TARGET_FINGERPRINT = targetFingerprint({
  host: PAID_STAGING_PUBLIC_TARGET.host,
  port: PAID_STAGING_PUBLIC_TARGET.port,
  database: PAID_STAGING_PUBLIC_TARGET.database
});
const RESTORE_TARGET_FINGERPRINT = targetFingerprint({
  host: PAID_STAGING_PUBLIC_TARGET.host,
  port: PAID_STAGING_PUBLIC_TARGET.port,
  database: RESTORE_DISPOSABLE_DATABASE_NAME
});
const CURRENT_IDENTITY = Object.freeze({
  runId: RUN_ID,
  commit: COMMIT,
  renderCommitVerified: true,
  codeManifestSha256: CODE_MANIFEST_SHA256,
  codeManifestFileCount: CODE_MANIFEST_FILE_COUNT,
  environment: "staging",
  environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
  region: "oregon"
});

function stepEvidence(
  sequence,
  databasePurpose,
  databaseName,
  targetFingerprintValue
) {
  const minute = String((sequence - 1) * 2).padStart(2, "0");
  const completedMinute = String((sequence - 1) * 2 + 1).padStart(
    2,
    "0"
  );
  return {
    ...CURRENT_IDENTITY,
    sequence,
    databasePurpose,
    databaseName,
    targetFingerprint: targetFingerprintValue,
    startedAt: `2026-07-31T12:${minute}:00.000Z`,
    completedAt: `2026-07-31T12:${completedMinute}:00.000Z`
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-evidence-report-")
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

function fixture(t, overrides = {}) {
  const directory = temporaryDirectory(t);
  const bundleFile = path.join(
    directory,
    `social-2b-${RUN_ID}.ia4sb`
  );
  fs.writeFileSync(bundleFile, "synthetic encrypted bundle", {
    flag: "wx",
    mode: 0o600
  });
  const bundleBytes = fs.readFileSync(bundleFile);
  const bundleSha256 = crypto
    .createHash("sha256")
    .update(bundleBytes)
    .digest("hex");
  bundleBytes.fill(0);
  const payloads = {
    backup: {
      ok: true,
      mode: "backup",
      evidenceVerified: true,
      evidenceSha256: EVIDENCE_SHA256,
      fileCount: 1,
      bundleSize: fs.statSync(bundleFile).size,
      bundleSha256,
      bundleFileFsyncConfirmed: true,
      bundleDirectoryFsyncConfirmed: true,
      bundleRoundTripVerified: true,
      temporaryWorkspaceCleanupConfirmed: true,
      plaintextArtifactsAbsent: true,
      ...stepEvidence(
        1,
        "primary-backup",
        PAID_STAGING_PUBLIC_TARGET.database,
        PRIMARY_TARGET_FINGERPRINT
      ),
      ...overrides.backup
    },
    create: {
      ok: true,
      safe: true,
      created: true,
      dropped: false,
      identityVerified: true,
      sessionsTerminated: false,
      absenceConfirmed: false,
      restoreTopologyPrepared: true,
      ...stepEvidence(
        2,
        "disposable-restore",
        RESTORE_DISPOSABLE_DATABASE_NAME,
        RESTORE_TARGET_FINGERPRINT
      ),
      ...overrides.create
    },
    restore: {
      ok: true,
      mode: "restore",
      evidenceVerified: true,
      evidenceSha256: EVIDENCE_SHA256,
      runtimeIsolation: true,
      vault: true,
      compatibleWith2A: true,
      temporaryWorkspaceCleanupConfirmed: true,
      plaintextArtifactsAbsent: true,
      ...stepEvidence(
        3,
        "disposable-restore",
        RESTORE_DISPOSABLE_DATABASE_NAME,
        RESTORE_TARGET_FINGERPRINT
      ),
      ...overrides.restore
    },
    drop: {
      ok: true,
      safe: true,
      created: false,
      dropped: true,
      identityVerified: true,
      sessionsTerminated: true,
      absenceConfirmed: true,
      ...stepEvidence(
        4,
        "disposable-restore",
        RESTORE_DISPOSABLE_DATABASE_NAME,
        RESTORE_TARGET_FINGERPRINT
      ),
      ...overrides.drop
    }
  };
  const inputs = {};
  for (const [label, payload] of Object.entries(payloads)) {
    inputs[`${label}File`] = path.join(directory, `${label}.json`);
    writeJson(inputs[`${label}File`], payload);
  }
  return Object.freeze({
    ...inputs,
    bundleFile,
    reportFile: path.join(directory, "final-evidence.json"),
    directory
  });
}

function runFixture(files, overrides = {}) {
  return createDurableEvidenceReport({
    ...files,
    currentIdentity: CURRENT_IDENTITY,
    completedAt: COMPLETED_AT,
    ...overrides
  });
}

function linuxLikeFileSystem() {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "fsyncSync") {
        return (descriptor) => {
          if (
            process.platform === "win32" &&
            target.fstatSync(descriptor).isDirectory()
          ) {
            return;
          }
          return target.fsyncSync(descriptor);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function capture() {
  let value = "";
  return Object.freeze({
    stream: Object.freeze({
      write(chunk) {
        value += String(chunk);
        return true;
      }
    }),
    read() {
      return value;
    }
  });
}

test("durable report rehashes the bundle and publishes a final sidecar", (t) => {
  const files = fixture(t);
  const result = runFixture(files, {
    fileSystem: linuxLikeFileSystem()
  });
  const sidecarFile = `${files.reportFile}.sha256`;
  assert.equal(fs.existsSync(files.reportFile), true);
  assert.equal(fs.existsSync(sidecarFile), true);
  assert.equal(fs.existsSync(`${files.reportFile}.partial`), false);
  assert.equal(fs.existsSync(`${sidecarFile}.partial`), false);
  assert.equal(result.publication.reportFileFsyncConfirmed, true);
  assert.equal(result.publication.reportDirectoryFsyncConfirmed, true);
  assert.equal(result.publication.sidecarFileFsyncConfirmed, true);
  assert.equal(result.publication.sidecarDirectoryFsyncConfirmed, true);
  assert.equal(result.publication.finalReportHashVerified, true);
  assert.equal(result.publication.finalBundleHashVerified, true);

  const serialized = fs.readFileSync(files.reportFile, "utf8");
  const report = JSON.parse(serialized);
  assert.equal(report.ok, true);
  assert.equal(report.code.commit, COMMIT);
  assert.equal(
    report.steps.backup.bundleFile,
    `social-2b-${RUN_ID}.ia4sb`
  );
  assert.equal(report.steps.backup.independentHashVerified, true);
  assert.equal(report.steps.restore.restoredContentMatchesBackup, true);
  assert.equal(report.steps.drop.absenceConfirmed, true);
  assert.equal(report.postconditions.plaintextArtifactsAbsent, true);
  assert.equal(serialized.includes(files.directory), false);
  assert.equal(serialized.includes("postgresql://"), false);

  const expectedHash = crypto
    .createHash("sha256")
    .update(Buffer.from(serialized, "utf8"))
    .digest("hex");
  assert.equal(result.publication.reportSha256, expectedHash);
  assert.equal(
    fs.readFileSync(sidecarFile, "ascii"),
    `${expectedHash}  final-evidence.json\n`
  );
});

test("report refuses a changed bundle and mismatched restored evidence", (t) => {
  const tampered = fixture(t);
  fs.appendFileSync(tampered.bundleFile, "tampered");
  assert.throws(
    () => runFixture(tampered),
    { code: "social_evidence_bundle_hash_mismatch" }
  );
  assert.equal(fs.existsSync(tampered.reportFile), false);

  const mismatched = fixture(t, {
    restore: { evidenceSha256: "c".repeat(64) }
  });
  assert.throws(
    () => runFixture(mismatched),
    { code: "social_evidence_restore_digest_mismatch" }
  );
  assert.equal(fs.existsSync(mismatched.reportFile), false);
});

test("same-size metadata changes during bundle hashing are refused", (t) => {
  const files = fixture(t);
  const opened = new Map();
  const fstatCounts = new Map();
  const changingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (file, ...args) => {
          const descriptor = target.openSync(file, ...args);
          opened.set(descriptor, path.resolve(String(file)));
          return descriptor;
        };
      }
      if (property === "closeSync") {
        return (descriptor) => {
          opened.delete(descriptor);
          fstatCounts.delete(descriptor);
          return target.closeSync(descriptor);
        };
      }
      if (property === "fstatSync") {
        return (descriptor) => {
          const metadata = target.fstatSync(descriptor);
          const count = (fstatCounts.get(descriptor) || 0) + 1;
          fstatCounts.set(descriptor, count);
          if (
            opened.get(descriptor) === path.resolve(files.bundleFile) &&
            count > 1
          ) {
            return new Proxy(metadata, {
              get(stat, name) {
                if (name === "mtimeMs") return stat.mtimeMs + 1;
                const value = stat[name];
                return typeof value === "function"
                  ? value.bind(stat)
                  : value;
              }
            });
          }
          return metadata;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  assert.throws(
    () =>
      runFixture(files, {
        fileSystem: changingFileSystem
      }),
    { code: "social_evidence_bundle_invalid_changed" }
  );
  assert.equal(fs.existsSync(files.reportFile), false);
});

test("evidence replay from another run or code manifest is refused", (t) => {
  const mixedRun = fixture(t, {
    drop: { runId: "87654321-4321-4cba-9fed-0987654321ab" }
  });
  assert.throws(
    () => runFixture(mixedRun),
    { code: "social_evidence_execution_mismatch" }
  );
  assert.equal(fs.existsSync(mixedRun.reportFile), false);

  const staleCode = fixture(t, {
    restore: { codeManifestSha256: "f".repeat(64) }
  });
  assert.throws(
    () => runFixture(staleCode),
    { code: "social_evidence_execution_mismatch" }
  );
  assert.equal(fs.existsSync(staleCode.reportFile), false);

  const falseCurrentCode = fixture(t);
  assert.throws(
    () =>
      runFixture(falseCurrentCode, {
        currentIdentity: {
          ...CURRENT_IDENTITY,
          codeManifestSha256: "a".repeat(64)
        }
      }),
    { code: "social_evidence_current_code_mismatch" }
  );
  assert.equal(fs.existsSync(falseCurrentCode.reportFile), false);
});

test("cleanup proof is mandatory and unknown evidence fields are refused", (t) => {
  const incompleteDrop = fixture(t, {
    drop: { absenceConfirmed: false }
  });
  assert.throws(
    () => runFixture(incompleteDrop),
    { code: "social_evidence_drop_invalid" }
  );
  assert.equal(fs.existsSync(incompleteDrop.reportFile), false);

  const plaintextRemaining = fixture(t, {
    backup: { plaintextArtifactsAbsent: false }
  });
  assert.throws(
    () => runFixture(plaintextRemaining),
    { code: "social_evidence_backup_invalid" }
  );
  assert.equal(fs.existsSync(plaintextRemaining.reportFile), false);

  const extra = fixture(t, {
    backup: { secret: "must-not-be-accepted" }
  });
  assert.throws(
    () => runFixture(extra),
    { code: "social_evidence_backup_invalid" }
  );
  assert.equal(fs.existsSync(extra.reportFile), false);
});

test("an existing report is preserved and never overwritten", (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.reportFile, "existing-owner", {
    flag: "wx",
    mode: 0o600
  });
  assert.throws(
    () => runFixture(files),
    { code: "social_evidence_report_publication_failed" }
  );
  assert.equal(fs.readFileSync(files.reportFile, "utf8"), "existing-owner");
  assert.equal(fs.existsSync(`${files.reportFile}.partial`), false);
});

test("a report path inside a Git tree is refused", (t) => {
  const files = fixture(t);
  fs.mkdirSync(path.join(files.directory, ".git"));
  assert.throws(
    () =>
      runFixture(files, {
        fileSystem: linuxLikeFileSystem()
      }),
    { code: "social_evidence_report_inside_git_refused" }
  );
  assert.equal(fs.existsSync(files.reportFile), false);
});

test("file fsync failure cannot leave an approved report", (t) => {
  const files = fixture(t);
  let fsyncCalls = 0;
  const failingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "fsyncSync") {
        return (descriptor) => {
          fsyncCalls += 1;
          if (fsyncCalls === 1) {
            throw Object.assign(new Error("synthetic fsync failure"), {
              code: "EIO"
            });
          }
          return target.fsyncSync(descriptor);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => runFixture(files, { fileSystem: failingFileSystem }),
    { code: "social_evidence_report_publication_failed" }
  );
  assert.equal(fs.existsSync(files.reportFile), false);
  assert.equal(fs.existsSync(`${files.reportFile}.partial`), false);
  assert.equal(fs.existsSync(`${files.reportFile}.sha256`), false);
});

test("a hardlink followed by lstat failure is completely cleaned", (t) => {
  const files = fixture(t);
  let reportLinked = false;
  let injected = false;
  const failingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "linkSync") {
        return (source, destination) => {
          target.linkSync(source, destination);
          if (path.resolve(destination) === path.resolve(files.reportFile)) {
            reportLinked = true;
          }
        };
      }
      if (property === "lstatSync") {
        return (file, ...args) => {
          if (
            reportLinked &&
            !injected &&
            path.resolve(String(file)) === path.resolve(files.reportFile)
          ) {
            injected = true;
            throw Object.assign(new Error("synthetic lstat failure"), {
              code: "EIO"
            });
          }
          return target.lstatSync(file, ...args);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => runFixture(files, { fileSystem: failingFileSystem }),
    { code: "social_evidence_report_publication_failed" }
  );
  assert.equal(injected, true);
  assert.equal(fs.existsSync(files.reportFile), false);
  assert.equal(fs.existsSync(`${files.reportFile}.partial`), false);
  assert.equal(fs.existsSync(`${files.reportFile}.sha256`), false);
});

test("a concurrent final-path owner is preserved and never adopted", (t) => {
  const files = fixture(t);
  const concurrentBytes = "concurrent-owner";
  let substituted = false;
  const competingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "linkSync") {
        return (source, destination) => {
          target.linkSync(source, destination);
          if (path.resolve(destination) === path.resolve(files.reportFile)) {
            target.unlinkSync(destination);
            target.writeFileSync(destination, concurrentBytes, {
              flag: "wx",
              mode: 0o600
            });
            substituted = true;
          }
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => runFixture(files, { fileSystem: competingFileSystem }),
    { code: "social_evidence_report_cleanup_failed" }
  );
  assert.equal(substituted, true);
  assert.equal(fs.readFileSync(files.reportFile, "utf8"), concurrentBytes);
  assert.equal(fs.existsSync(`${files.reportFile}.partial`), false);
  assert.equal(fs.existsSync(`${files.reportFile}.sha256`), false);
});

test("report mutation before sidecar completion leaves no approval files", (t) => {
  const files = fixture(t);
  const sidecarFile = `${files.reportFile}.sha256`;
  let mutated = false;
  const mutatingFileSystem = new Proxy(linuxLikeFileSystem(), {
    get(target, property) {
      if (property === "linkSync") {
        return (source, destination) => {
          target.linkSync(source, destination);
          if (path.resolve(destination) === path.resolve(sidecarFile)) {
            const bytes = fs.readFileSync(files.reportFile);
            bytes[0] ^= 1;
            fs.writeFileSync(files.reportFile, bytes);
            bytes.fill(0);
            mutated = true;
          }
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => runFixture(files, { fileSystem: mutatingFileSystem }),
    { code: "social_evidence_report_final_hash_failed" }
  );
  assert.equal(mutated, true);
  assert.equal(fs.existsSync(files.reportFile), false);
  assert.equal(fs.existsSync(sidecarFile), false);
});

test("bundle mutation before final publication is detected and cleaned", (t) => {
  const files = fixture(t);
  const sidecarFile = `${files.reportFile}.sha256`;
  let mutated = false;
  const mutatingFileSystem = new Proxy(linuxLikeFileSystem(), {
    get(target, property) {
      if (property === "linkSync") {
        return (source, destination) => {
          target.linkSync(source, destination);
          if (path.resolve(destination) === path.resolve(sidecarFile)) {
            fs.appendFileSync(files.bundleFile, "changed");
            mutated = true;
          }
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => runFixture(files, { fileSystem: mutatingFileSystem }),
    { code: "social_evidence_bundle_final_hash_failed" }
  );
  assert.equal(mutated, true);
  assert.equal(fs.existsSync(files.reportFile), false);
  assert.equal(fs.existsSync(sidecarFile), false);
});

test("operator entry point is Linux-only and emits no paths", async () => {
  const stdout = capture();
  const stderr = capture();
  let called = false;
  const status = await main({
    env: {},
    argv: [],
    platform: "win32",
    stdout: stdout.stream,
    stderr: stderr.stream,
    createReport() {
      called = true;
    }
  });
  assert.equal(status, 1);
  assert.equal(called, false);
  assert.equal(stdout.read(), "");
  assert.deepEqual(JSON.parse(stderr.read()), {
    ok: false,
    code: "social_evidence_linux_required"
  });

  const linuxStdout = capture();
  const linuxStderr = capture();
  const linuxStatus = await main({
    env: {},
    argv: [],
    platform: "linux",
    stdout: linuxStdout.stream,
    stderr: linuxStderr.stream,
    loadIdentity: () => CURRENT_IDENTITY,
    createReport() {
      return {
        publication: {
          reportSha256: "d".repeat(64),
          reportFileFsyncConfirmed: true,
          reportDirectoryFsyncConfirmed: true,
          sidecarFileFsyncConfirmed: true,
          sidecarDirectoryFsyncConfirmed: true,
          finalReportHashVerified: true,
          finalBundleHashVerified: true
        }
      };
    }
  });
  assert.equal(linuxStatus, 0);
  assert.equal(linuxStderr.read(), "");
  assert.deepEqual(JSON.parse(linuxStdout.read()), {
    ok: true,
    reportSha256: "d".repeat(64),
    reportFileFsyncConfirmed: true,
    reportDirectoryFsyncConfirmed: true,
    sidecarFileFsyncConfirmed: true,
    sidecarDirectoryFsyncConfirmed: true,
    finalReportHashVerified: true,
    finalBundleHashVerified: true
  });

  const refusedStdout = capture();
  const refusedStderr = capture();
  const refusedStatus = await main({
    env: {},
    argv: [],
    platform: "linux",
    stdout: refusedStdout.stream,
    stderr: refusedStderr.stream,
    loadIdentity: () => CURRENT_IDENTITY,
    createReport() {
      return { publication: { reportSha256: "d".repeat(64) } };
    }
  });
  assert.equal(refusedStatus, 1);
  assert.equal(refusedStdout.read(), "");
  assert.deepEqual(JSON.parse(refusedStderr.read()), {
    ok: false,
    code: "social_evidence_publication_unconfirmed"
  });
});
