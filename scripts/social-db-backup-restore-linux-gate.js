"use strict";

// Linux-only operator gate. It is deliberately not imported by server.js.
// Secrets are accepted only through the process environment.
const fs = require("node:fs");
const path = require("node:path");
const {
  main: runBackupRestoreOperator
} = require("./social-db-backup-restore");
const {
  createRestoreBehaviorVerifiers
} = require(
  "../src/persistence/postgres/restore-behavior-verifiers"
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
  CUSTOM_TRUST_ENVIRONMENT_NAMES,
  loadSystemPostgresTls
} = require("../src/persistence/postgres/tls");
const {
  completePhysicalEvidence,
  loadExecutionIdentity,
  startPhysicalEvidence
} = require("../src/persistence/postgres/physical-gate-evidence");

const MAX_CAPTURE_BYTES = 64 * 1024;
const SAFE_CODE = /^[a-z0-9_]{3,100}$/;

class SocialPostgresLinuxGateError extends Error {
  constructor(code) {
    super(code);
    this.name = "SocialPostgresLinuxGateError";
    this.code = code;
  }
}

function fail(code) {
  throw new SocialPostgresLinuxGateError(code);
}

function requireText(value, code) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0
  ) {
    fail(code);
  }
  return value;
}

function requireAbsolutePath(value, code) {
  const supplied = requireText(value, code);
  if (!path.isAbsolute(supplied)) fail(code);
  return path.resolve(supplied);
}

function publicTarget(database) {
  return Object.freeze({
    host: PAID_STAGING_PUBLIC_TARGET.host,
    port: PAID_STAGING_PUBLIC_TARGET.port,
    database
  });
}

const PRIMARY_TARGET_FINGERPRINT = targetFingerprint(
  publicTarget(PAID_STAGING_PUBLIC_TARGET.database)
);
const RESTORE_TARGET_FINGERPRINT = targetFingerprint(
  publicTarget(RESTORE_DISPOSABLE_DATABASE_NAME)
);

function exactValue(env, name, expected, code) {
  if (requireText(env[name], code) !== expected) fail(code);
}

function assertPinnedDatabaseUrl(raw, expectedLogin, expectedDatabase, code) {
  let parsed;
  try {
    parsed = new URL(requireText(raw, code));
  } catch {
    fail(code);
  }
  let login;
  let database;
  try {
    login = decodeURIComponent(parsed.username).toLowerCase();
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    fail(code);
  }
  const queryKeys = [...new Set(parsed.searchParams.keys())];
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname.toLowerCase() !== PAID_STAGING_PUBLIC_TARGET.host ||
    (parsed.port || "5432") !== PAID_STAGING_PUBLIC_TARGET.port ||
    database !== expectedDatabase ||
    login !== expectedLogin ||
    !parsed.password ||
    parsed.hash ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode").toLowerCase() !== "verify-full"
  ) {
    fail(code);
  }
  return true;
}

function assertExpectedTarget(
  env,
  prefix,
  expectedLogin,
  expectedDatabase,
  expectedFingerprint,
  code
) {
  exactValue(
    env,
    `${prefix}_EXPECTED_HOST`,
    PAID_STAGING_PUBLIC_TARGET.host,
    code
  );
  exactValue(
    env,
    `${prefix}_EXPECTED_PORT`,
    PAID_STAGING_PUBLIC_TARGET.port,
    code
  );
  exactValue(env, `${prefix}_EXPECTED_DATABASE`, expectedDatabase, code);
  exactValue(env, `${prefix}_EXPECTED_LOGIN`, expectedLogin, code);
  exactValue(
    env,
    `${prefix}_EXPECTED_FINGERPRINT`,
    expectedFingerprint,
    code
  );
}

function postgresTlsEnvironment(env) {
  const isolated = {
    NODE_TLS_REJECT_UNAUTHORIZED:
      env.NODE_TLS_REJECT_UNAUTHORIZED
  };
  for (const name of CUSTOM_TRUST_ENVIRONMENT_NAMES) {
    isolated[name] = env[name];
  }
  return Object.freeze(isolated);
}

function validatePinnedLinuxGateEnvironment(
  mode,
  env = process.env,
  executionIdentity = loadExecutionIdentity(env)
) {
  loadSystemPostgresTls(
    env,
    PAID_STAGING_PUBLIC_TARGET.host
  );
  exactValue(
    env,
    mode === "backup"
      ? "SOCIAL_BACKUP_EXPECTED_MIGRATION_LOGIN"
      : "SOCIAL_RESTORE_EXPECTED_MIGRATION_LOGIN",
    PAID_STAGING_PUBLIC_TARGET.migrationLogin,
    "linux_gate_migration_login_mismatch"
  );
  exactValue(
    env,
    mode === "backup"
      ? "SOCIAL_BACKUP_EXPECTED_RUNTIME_LOGIN"
      : "SOCIAL_RESTORE_EXPECTED_RUNTIME_LOGIN",
    PAID_STAGING_PUBLIC_TARGET.runtimeLogin,
    "linux_gate_runtime_login_mismatch"
  );

  if (mode === "backup") {
    exactValue(
      env,
      "SOCIAL_BACKUP_LABEL",
      `social-2b-${executionIdentity.runId}`,
      "linux_gate_backup_label_mismatch"
    );
    exactValue(
      env,
      "SOCIAL_BACKUP_EXPECTED_ENVIRONMENT_ID",
      PAID_STAGING_PUBLIC_TARGET.environmentId,
      "linux_gate_environment_mismatch"
    );
    exactValue(
      env,
      "SOCIAL_BACKUP_EXPECTED_ENVIRONMENT",
      "staging",
      "linux_gate_environment_mismatch"
    );
    assertPinnedDatabaseUrl(
      env.SOCIAL_BACKUP_SOURCE_DATABASE_URL,
      PAID_STAGING_PUBLIC_TARGET.migrationLogin,
      PAID_STAGING_PUBLIC_TARGET.database,
      "linux_gate_backup_source_mismatch"
    );
    assertPinnedDatabaseUrl(
      env.SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL,
      PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
      PAID_STAGING_PUBLIC_TARGET.database,
      "linux_gate_backup_operator_mismatch"
    );
    assertExpectedTarget(
      env,
      "SOCIAL_BACKUP_SOURCE",
      PAID_STAGING_PUBLIC_TARGET.migrationLogin,
      PAID_STAGING_PUBLIC_TARGET.database,
      PRIMARY_TARGET_FINGERPRINT,
      "linux_gate_backup_source_mismatch"
    );
    assertExpectedTarget(
      env,
      "SOCIAL_BACKUP_OPERATOR",
      PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
      PAID_STAGING_PUBLIC_TARGET.database,
      PRIMARY_TARGET_FINGERPRINT,
      "linux_gate_backup_operator_mismatch"
    );
    return true;
  }

  if (mode !== "restore") fail("linux_gate_mode_invalid");
  exactValue(
    env,
    "SOCIAL_RESTORE_LABEL",
    `social-2b-${executionIdentity.runId}`,
    "linux_gate_restore_label_mismatch"
  );
  assertPinnedDatabaseUrl(
    env.SOCIAL_RESTORE_TARGET_DATABASE_URL,
    PAID_STAGING_PUBLIC_TARGET.migrationLogin,
    RESTORE_DISPOSABLE_DATABASE_NAME,
    "linux_gate_restore_target_mismatch"
  );
  assertPinnedDatabaseUrl(
    env.SOCIAL_RESTORE_RUNTIME_DATABASE_URL,
    PAID_STAGING_PUBLIC_TARGET.runtimeLogin,
    RESTORE_DISPOSABLE_DATABASE_NAME,
    "linux_gate_restore_runtime_mismatch"
  );
  assertPinnedDatabaseUrl(
    env.SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL,
    PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    RESTORE_DISPOSABLE_DATABASE_NAME,
    "linux_gate_restore_operator_mismatch"
  );
  assertExpectedTarget(
    env,
    "SOCIAL_RESTORE_TARGET",
    PAID_STAGING_PUBLIC_TARGET.migrationLogin,
    RESTORE_DISPOSABLE_DATABASE_NAME,
    RESTORE_TARGET_FINGERPRINT,
    "linux_gate_restore_target_mismatch"
  );
  assertExpectedTarget(
    env,
    "SOCIAL_RESTORE_OPERATOR",
    PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    RESTORE_DISPOSABLE_DATABASE_NAME,
    RESTORE_TARGET_FINGERPRINT,
    "linux_gate_restore_operator_mismatch"
  );
  exactValue(
    env,
    "SOCIAL_RESTORE_SOURCE_FINGERPRINT",
    PRIMARY_TARGET_FINGERPRINT,
    "linux_gate_restore_source_mismatch"
  );
  return true;
}

function sameObjectIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino
  );
}

function physicalNoFollowProbe({
  root,
  fileSystem = fs,
  constants = fs.constants
}) {
  const resolvedRoot = requireAbsolutePath(
    root,
    "linux_gate_probe_root_invalid"
  );
  let rootStat;
  let realRoot;
  try {
    rootStat = fileSystem.lstatSync(resolvedRoot);
    realRoot = path.resolve(fileSystem.realpathSync(resolvedRoot));
  } catch {
    fail("linux_gate_probe_root_invalid");
  }
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    realRoot !== resolvedRoot ||
    !Number.isSafeInteger(constants?.O_NOFOLLOW) ||
    constants.O_NOFOLLOW === 0
  ) {
    fail("linux_gate_nofollow_unavailable");
  }

  let directory;
  let directoryIdentity;
  let source;
  let sourceIdentity;
  let link;
  let linkIdentity;
  let descriptor;
  let cleanupFailed = false;
  try {
    directory = fileSystem.mkdtempSync(
      path.join(resolvedRoot, ".ia4tube-nofollow-probe-")
    );
    fileSystem.chmodSync(directory, 0o700);
    directoryIdentity = fileSystem.lstatSync(directory);
    if (
      !directoryIdentity.isDirectory() ||
      directoryIdentity.isSymbolicLink() ||
      (directoryIdentity.mode & 0o077) !== 0
    ) {
      fail("linux_gate_probe_directory_invalid");
    }

    source = path.join(directory, "source");
    link = path.join(directory, "link");
    fileSystem.writeFileSync(source, "synthetic nofollow probe\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fileSystem.chmodSync(source, 0o600);
    sourceIdentity = fileSystem.lstatSync(source);
    fileSystem.symlinkSync(path.basename(source), link, "file");
    linkIdentity = fileSystem.lstatSync(link);
    if (
      !sourceIdentity.isFile() ||
      sourceIdentity.isSymbolicLink() ||
      (sourceIdentity.mode & 0o077) !== 0 ||
      !linkIdentity.isSymbolicLink()
    ) {
      fail("linux_gate_probe_files_invalid");
    }

    try {
      descriptor = fileSystem.openSync(
        link,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
    } catch (error) {
      if (error?.code !== "ELOOP") {
        fail("linux_gate_nofollow_unconfirmed");
      }
      return true;
    }
    fail("linux_gate_nofollow_unconfirmed");
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        cleanupFailed = true;
      }
    }
    for (const [file, identity, expectedKind] of [
      [link, linkIdentity, "link"],
      [source, sourceIdentity, "file"]
    ]) {
      if (!file || !identity) continue;
      try {
        const current = fileSystem.lstatSync(file);
        const kindExact =
          expectedKind === "link"
            ? current.isSymbolicLink()
            : current.isFile() && !current.isSymbolicLink();
        if (!kindExact || !sameObjectIdentity(identity, current)) {
          cleanupFailed = true;
          continue;
        }
        fileSystem.unlinkSync(file);
      } catch {
        cleanupFailed = true;
      }
    }
    if (directory && directoryIdentity) {
      try {
        const current = fileSystem.lstatSync(directory);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          !sameObjectIdentity(directoryIdentity, current)
        ) {
          cleanupFailed = true;
        } else {
          fileSystem.rmdirSync(directory);
        }
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) fail("linux_gate_probe_cleanup_failed");
  }
}

function assertLinuxNoFollow({
  platform = process.platform,
  root,
  probe = physicalNoFollowProbe
}) {
  if (platform !== "linux") fail("linux_gate_linux_required");
  if (typeof probe !== "function" || probe({ root }) !== true) {
    fail("linux_gate_nofollow_unconfirmed");
  }
  return true;
}

function captureSink() {
  let value = "";
  let bytes = 0;
  return Object.freeze({
    stream: Object.freeze({
      write(chunk) {
        const text = String(chunk);
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_CAPTURE_BYTES) {
          fail("linux_gate_operator_output_limit");
        }
        value += text;
        return true;
      }
    }),
    read() {
      return value;
    }
  });
}

function parsePayload(text, code) {
  const serialized = String(text || "").trim();
  if (!serialized || serialized.includes("\n")) fail(code);
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    fail(code);
  }
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    fail(code);
  }
  return payload;
}

function safeFailurePayload(text, fallback) {
  try {
    const payload = parsePayload(text, fallback);
    if (payload.ok === false && SAFE_CODE.test(String(payload.code || ""))) {
      return Object.freeze({ ok: false, code: payload.code });
    }
  } catch {
    // The stable fallback below is authoritative.
  }
  return Object.freeze({ ok: false, code: fallback });
}

function safeSuccessPayload(mode, text) {
  const payload = parsePayload(
    text,
    "linux_gate_operator_result_invalid"
  );
  if (
    payload.ok !== true ||
    payload.mode !== mode ||
    payload.evidenceVerified !== true ||
    payload.temporaryWorkspaceCleanupConfirmed !== true ||
    payload.plaintextArtifactsAbsent !== true
  ) {
    fail("linux_gate_operator_result_invalid");
  }
  if (
    mode === "backup" &&
    (payload.fileCount !== 1 ||
      !Number.isSafeInteger(payload.bundleSize) ||
      payload.bundleSize < 1 ||
      !/^[0-9a-f]{64}$/.test(String(payload.evidenceSha256 || "")) ||
      !/^[0-9a-f]{64}$/.test(String(payload.bundleSha256 || "")) ||
      payload.bundleFileFsyncConfirmed !== true ||
      payload.bundleRoundTripVerified !== true ||
      payload.bundleDirectoryFsyncConfirmed !== true)
  ) {
    fail("linux_gate_backup_durability_unconfirmed");
  }
  if (
    mode === "restore" &&
    (!/^[0-9a-f]{64}$/.test(String(payload.evidenceSha256 || "")) ||
      payload.runtimeIsolation !== true ||
      payload.vault !== true ||
      payload.compatibleWith2A !== true)
  ) {
    fail("linux_gate_restore_behavior_unconfirmed");
  }
  return mode === "backup"
    ? Object.freeze({
        ok: true,
        mode,
        evidenceVerified: true,
        evidenceSha256: payload.evidenceSha256,
        fileCount: 1,
        bundleSize: payload.bundleSize,
        bundleSha256: payload.bundleSha256,
        bundleFileFsyncConfirmed: true,
        bundleRoundTripVerified: true,
        bundleDirectoryFsyncConfirmed: true,
        temporaryWorkspaceCleanupConfirmed: true,
        plaintextArtifactsAbsent: true
      })
    : Object.freeze({
        ok: true,
        mode,
        evidenceVerified: true,
        evidenceSha256: payload.evidenceSha256,
        runtimeIsolation: true,
        vault: true,
        compatibleWith2A: true,
        temporaryWorkspaceCleanupConfirmed: true,
        plaintextArtifactsAbsent: true
      });
}

async function runCapturedOperator({
  env,
  mode,
  runOperator,
  verifiers,
  requireBundleDirectoryFsync
}) {
  const stdout = captureSink();
  const stderr = captureSink();
  const status = await runOperator({
    env,
    argv: [mode],
    stdout: stdout.stream,
    stderr: stderr.stream,
    verifiers,
    requireBundleDirectoryFsync
  });
  if (!Number.isSafeInteger(status) || status < 0 || status > 255) {
    fail("linux_gate_operator_status_invalid");
  }
  return Object.freeze({
    status,
    stdout: stdout.read(),
    stderr: stderr.read()
  });
}

function writePayload(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  platform = process.platform,
  stdout = process.stdout,
  stderr = process.stderr,
  noFollowProbe = physicalNoFollowProbe,
  runOperator = runBackupRestoreOperator,
  createVerifiers = createRestoreBehaviorVerifiers,
  validateTarget = validatePinnedLinuxGateEnvironment,
  loadIdentity = loadExecutionIdentity,
  startEvidence = startPhysicalEvidence,
  completeEvidence = completePhysicalEvidence,
  now = () => new Date()
} = {}) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 1 ||
    !["backup", "restore"].includes(argv[0])
  ) {
    writePayload(stderr, {
      ok: false,
      code: "linux_gate_argv_refused"
    });
    return 2;
  }

  const mode = argv[0];
  let gate;
  let outcome;
  let failure;
  let stepEvidence;
  try {
    if (typeof loadIdentity !== "function") {
      fail("linux_gate_execution_identity_invalid");
    }
    const identity = loadIdentity(env);
    if (
      typeof validateTarget !== "function" ||
      validateTarget(mode, env, identity) !== true
    ) {
      fail("linux_gate_target_unconfirmed");
    }
    if (
      typeof startEvidence !== "function" ||
      typeof completeEvidence !== "function"
    ) {
      fail("linux_gate_execution_evidence_invalid");
    }
    stepEvidence = startEvidence({
      identity,
      sequence: mode === "backup" ? 1 : 3,
      databasePurpose:
        mode === "backup" ? "primary-backup" : "disposable-restore",
      databaseName:
        mode === "backup"
          ? PAID_STAGING_PUBLIC_TARGET.database
          : RESTORE_DISPOSABLE_DATABASE_NAME,
      targetFingerprint:
        mode === "backup"
          ? PRIMARY_TARGET_FINGERPRINT
          : RESTORE_TARGET_FINGERPRINT,
      now
    });
    const probeRoot =
      mode === "backup"
        ? env.SOCIAL_BACKUP_OUTPUT_DIRECTORY
        : env.SOCIAL_RESTORE_WORK_DIRECTORY;
    assertLinuxNoFollow({
      platform,
      root: probeRoot,
      probe: noFollowProbe
    });

    if (mode === "restore") {
      if (typeof createVerifiers !== "function") {
        fail("linux_gate_restore_verifier_factory_invalid");
      }
      gate = createVerifiers({
        env: postgresTlsEnvironment(env),
        migrationDatabaseUrl: requireText(
          env.SOCIAL_RESTORE_TARGET_DATABASE_URL,
          "linux_gate_restore_migration_url_missing"
        ),
        runtimeDatabaseUrl: requireText(
          env.SOCIAL_RESTORE_RUNTIME_DATABASE_URL,
          "linux_gate_restore_runtime_url_missing"
        ),
        expectedMigrationLogin: requireText(
          env.SOCIAL_RESTORE_EXPECTED_MIGRATION_LOGIN,
          "linux_gate_restore_migration_login_missing"
        ),
        expectedRuntimeLogin: requireText(
          env.SOCIAL_RESTORE_EXPECTED_RUNTIME_LOGIN,
          "linux_gate_restore_runtime_login_missing"
        ),
        legacy2ARoot: requireAbsolutePath(
          env.SOCIAL_RESTORE_LEGACY_2A_ROOT,
          "linux_gate_restore_2a_root_missing"
        )
      });
      if (
        !gate ||
        !gate.verifiers ||
        typeof gate.close !== "function"
      ) {
        fail("linux_gate_restore_verifiers_invalid");
      }
    }

    if (typeof runOperator !== "function") {
      fail("linux_gate_operator_invalid");
    }
    outcome = await runCapturedOperator({
      env,
      mode,
      runOperator,
      verifiers: gate?.verifiers,
      requireBundleDirectoryFsync: mode === "backup"
    });
  } catch (error) {
    failure = error;
  }

  if (gate) {
    try {
      await gate.close();
    } catch (error) {
      failure = error?.code
        ? error
        : new SocialPostgresLinuxGateError(
            "linux_gate_restore_cleanup_failed"
          );
    }
  }

  if (failure) {
    writePayload(
      stderr,
      safeFailurePayload(
        JSON.stringify({
          ok: false,
          code: SAFE_CODE.test(String(failure.code || ""))
            ? failure.code
            : "linux_gate_failed"
        }),
        "linux_gate_failed"
      )
    );
    return 1;
  }
  if (!outcome || outcome.status !== 0) {
    writePayload(
      stderr,
      safeFailurePayload(
        outcome?.stderr,
        "linux_gate_operator_failed"
      )
    );
    return outcome?.status || 1;
  }

  let payload;
  try {
    payload = Object.freeze({
      ...safeSuccessPayload(mode, outcome.stdout),
      ...completeEvidence(stepEvidence, now)
    });
  } catch (error) {
    writePayload(
      stderr,
      safeFailurePayload(
        JSON.stringify({
          ok: false,
          code: SAFE_CODE.test(String(error?.code || ""))
            ? error.code
            : "linux_gate_operator_result_invalid"
        }),
        "linux_gate_operator_result_invalid"
      )
    );
    return 1;
  }
  writePayload(stdout, payload);
  return 0;
}

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  });
}

module.exports = {
  MAX_CAPTURE_BYTES,
  SocialPostgresLinuxGateError,
  PRIMARY_TARGET_FINGERPRINT,
  RESTORE_TARGET_FINGERPRINT,
  assertLinuxNoFollow,
  assertPinnedDatabaseUrl,
  captureSink,
  main,
  physicalNoFollowProbe,
  safeFailurePayload,
  safeSuccessPayload,
  validatePinnedLinuxGateEnvironment
};
