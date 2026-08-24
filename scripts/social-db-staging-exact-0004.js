"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  loadMigrationPostgresConfig
} = require("../src/persistence/postgres/config");
const {
  closePostgresPool,
  createPostgresPool
} = require("../src/persistence/postgres/pool");
const {
  assertExactStagingTarget,
  createMigrationRunner
} = require("../src/persistence/postgres/migrations");
const {
  loadStagingExactExecutionPackage
} = require("../src/persistence/postgres/staging-exact-0004");

const COMMANDS = new Set(["plan", "apply"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{0,127}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const BRANCH_PATTERN =
  /^(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/;
const RESTRICTED_ENVIRONMENT_NAME =
  /(?:^|_)(?:META|FACEBOOK|INSTAGRAM|PUBLICATION|PUBLISH|PUBLICACAO|DEPLOY|DEPLOYMENT)(?:_|$)/i;
const INACTIVE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const REQUIRED_DISABLED_SOCIAL_FLAGS = Object.freeze([
  "SOCIAL_INSTAGRAM_ENABLED",
  "SOCIAL_EXTERNAL_CONNECTION_ENABLED",
  "SOCIAL_EXTERNAL_PUBLICATION_ENABLED"
]);

class StagingExactCliFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "StagingExactCliFailure";
  }
}

function refuse(code) {
  throw new StagingExactCliFailure(code);
}

function hasConfiguredValue(value) {
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== undefined && value !== null;
}

function parseNamedArguments(args) {
  const parsed = new Map();
  for (const argument of args) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match) refuse("staging_exact_argument_invalid");
    if (parsed.has(match[1])) refuse("staging_exact_argument_duplicate");
    parsed.set(match[1], match[2]);
  }
  return parsed;
}

function parseStagingExactCommand(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length < 1) {
    refuse("staging_exact_command_invalid");
  }
  const command = String(argv[0] || "").trim().toLowerCase();
  if (!COMMANDS.has(command)) refuse("staging_exact_command_invalid");

  const named = parseNamedArguments(argv.slice(1));
  const expected = new Set([
    "execution-package",
    "execution-package-sha256",
    "recovery-evidence",
    "export-evidence"
  ]);
  if (
    named.size !== expected.size ||
    [...named.keys()].some((name) => !expected.has(name)) ||
    [...expected].some((name) => !named.has(name))
  ) {
    refuse("staging_exact_argument_set_invalid");
  }

  const packagePath = named.get("execution-package");
  if (!path.isAbsolute(packagePath)) {
    refuse("staging_exact_package_path_not_absolute");
  }
  const expectedPackageSha256 = named.get("execution-package-sha256");
  if (!SHA256_PATTERN.test(expectedPackageSha256)) {
    refuse("staging_exact_package_sha_invalid");
  }
  const recoveryEvidencePath = named.get("recovery-evidence");
  if (!path.isAbsolute(recoveryEvidencePath)) {
    refuse("staging_exact_recovery_evidence_path_not_absolute");
  }
  const exportEvidencePath = named.get("export-evidence");
  if (!path.isAbsolute(exportEvidencePath)) {
    refuse("staging_exact_export_evidence_path_not_absolute");
  }
  return Object.freeze({
    command,
    packagePath: path.resolve(packagePath),
    expectedPackageSha256,
    recoveryEvidencePath: path.resolve(recoveryEvidencePath),
    exportEvidencePath: path.resolve(exportEvidencePath)
  });
}

function requireEnvironmentPin(env, name, pattern, code) {
  const value = typeof env?.[name] === "string" ? env[name] : "";
  if (value !== value.trim() || !pattern.test(value)) refuse(code);
  return value;
}

function assertExternalIntegrationsDisabled(env = process.env) {
  if (hasConfiguredValue(env?.DATABASE_URL)) {
    refuse("staging_exact_runtime_database_url_forbidden");
  }
  for (const name of REQUIRED_DISABLED_SOCIAL_FLAGS) {
    if (
      typeof env?.[name] !== "string" ||
      env[name] !== env[name].trim() ||
      env[name].toLowerCase() !== "false"
    ) {
      refuse("staging_exact_external_social_flag_not_explicitly_disabled");
    }
  }
  for (const [name, rawValue] of Object.entries(env || {})) {
    if (!RESTRICTED_ENVIRONMENT_NAME.test(String(name))) continue;
    if (!hasConfiguredValue(rawValue)) continue;
    const value = String(rawValue).trim().toLowerCase();
    if (!INACTIVE_VALUES.has(value)) {
      refuse("staging_exact_external_integration_forbidden");
    }
  }
}

function packageLoadOptions(parsed, env, repositoryRoot) {
  if (typeof env?.SOCIAL_STAGING_EXACT_APPROVED !== "string") {
    refuse("staging_exact_approval_required");
  }
  const approval = env.SOCIAL_STAGING_EXACT_APPROVED;
  if (!approval || approval !== approval.trim()) {
    refuse("staging_exact_approval_required");
  }
  return Object.freeze({
    packagePath: parsed.packagePath,
    expectedPackageSha256: parsed.expectedPackageSha256,
    recoveryEvidencePath: parsed.recoveryEvidencePath,
    exportEvidencePath: parsed.exportEvidencePath,
    repositoryRoot,
    expectedCommit: requireEnvironmentPin(
      env,
      "SOCIAL_STAGING_EXACT_EXPECTED_COMMIT",
      COMMIT_PATTERN,
      "staging_exact_expected_commit_invalid"
    ),
    expectedBranch: requireEnvironmentPin(
      env,
      "SOCIAL_STAGING_EXACT_EXPECTED_BRANCH",
      BRANCH_PATTERN,
      "staging_exact_expected_branch_invalid"
    ),
    approval
  });
}

function inspectRepositoryState(repositoryRoot) {
  function gitText(args, code) {
    try {
      return execFileSync("git", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      refuse(code);
    }
  }
  const commit = gitText(
    ["rev-parse", "--verify", "HEAD"],
    "staging_exact_repository_commit_unavailable"
  );
  const branch = gitText(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "staging_exact_repository_branch_unavailable"
  );
  let status;
  try {
    status = execFileSync(
      "git",
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      {
        cwd: repositoryRoot,
        encoding: null,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
  } catch {
    refuse("staging_exact_repository_status_unavailable");
  }
  if (!COMMIT_PATTERN.test(commit)) {
    refuse("staging_exact_repository_commit_invalid");
  }
  if (!BRANCH_PATTERN.test(branch)) {
    refuse("staging_exact_repository_branch_invalid");
  }
  if (!Buffer.isBuffer(status) || status.length !== 0) {
    refuse("staging_exact_repository_not_clean");
  }
  return Object.freeze({ commit, branch, clean: true });
}

function assertRepositoryMatchesPackage(repositoryState, executionPackage) {
  if (
    repositoryState?.clean !== true ||
    repositoryState.commit !== executionPackage?.commit ||
    repositoryState.branch !== executionPackage?.branch
  ) {
    refuse("staging_exact_repository_package_mismatch");
  }
}

function safePlan(plan) {
  return Object.freeze({
    fromProfile: plan?.fromProfile,
    toProfile: plan?.toProfile,
    expectedPending: plan?.expectedPending,
    observedPending: plan?.observedPending,
    beforeCatalogSha256: plan?.beforeCatalogSha256,
    migrationSha256: plan?.migrationSha256,
    executionPackageDigest: plan?.executionPackageDigest,
    recoveryEvidenceDigest: plan?.recoveryEvidenceDigest,
    planApproved: plan?.planApproved === true,
    readOnly: plan?.readOnly === true
  });
}

function safeApply(result) {
  return Object.freeze({
    fromProfile: result?.fromProfile,
    toProfile: result?.toProfile,
    expectedPending: result?.expectedPending,
    observedPending: result?.observedPending,
    appliedMigration: result?.appliedMigration,
    finalProfile: result?.finalProfile,
    finalCatalogSha256: result?.finalCatalogSha256,
    postCommitValidated: result?.postCommitValidated === true,
    recoveryReferenceDigest: result?.recoveryReferenceDigest,
    recoveryCapturedAt: result?.recoveryCapturedAt,
    recoveryEvidenceDigest: result?.recoveryEvidenceDigest,
    recoveryEvidenceExternallyVerified:
      result?.recoveryEvidenceExternallyVerified === true,
    recoveryEvidencePackageBound:
      result?.recoveryEvidencePackageBound === true,
    executionPackageDigest: result?.executionPackageDigest,
    retryAllowed: result?.retryAllowed === false ? false : undefined
  });
}

function safeCode(value, fallback) {
  return typeof value === "string" && SAFE_CODE_PATTERN.test(value)
    ? value
    : fallback;
}

function failurePayload(error) {
  const failure = {
    ok: false,
    code: safeCode(error?.code, "staging_exact_command_failed")
  };
  if (error?.applied === true) failure.applied = true;
  if (error?.outcomeUnknown === true) failure.outcomeUnknown = true;
  if (error?.retryAllowed === false) failure.retryAllowed = false;
  if (error?.requiresReadOnlyInspection === true) {
    failure.requiresReadOnlyInspection = true;
  }
  return failure;
}

function classifyAfterApplyFailure(error) {
  const failure =
    error && typeof error === "object"
      ? error
      : new StagingExactCliFailure("staging_exact_postapply_failure");
  failure.applied = true;
  failure.retryAllowed = false;
  failure.requiresReadOnlyInspection = true;
  return failure;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  repositoryRoot = path.resolve(__dirname, ".."),
  loadPackageImpl = loadStagingExactExecutionPackage,
  inspectRepositoryImpl = inspectRepositoryState,
  loadConfigImpl = loadMigrationPostgresConfig,
  assertTargetImpl = assertExactStagingTarget,
  createPoolImpl = createPostgresPool,
  closePoolImpl = closePostgresPool,
  createRunnerImpl = createMigrationRunner,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let parsed;
  try {
    parsed = parseStagingExactCommand(argv);
  } catch (error) {
    stderr.write(`${JSON.stringify(failurePayload(error))}\n`);
    return 2;
  }

  let pool;
  let output;
  let operationFailure;
  let applyCompleted = false;
  try {
    assertExternalIntegrationsDisabled(env);
    if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
      refuse("staging_exact_repository_root_invalid");
    }

    // The immutable execution package and all external pins are closed before
    // any database configuration is consumed or a connection pool can exist.
    const loaded = loadPackageImpl(
      packageLoadOptions(parsed, env, path.resolve(repositoryRoot))
    );
    assertRepositoryMatchesPackage(
      inspectRepositoryImpl(path.resolve(repositoryRoot)),
      loaded.executionPackage
    );
    const configuration = loadConfigImpl(env);
    assertTargetImpl(configuration.target, loaded.request);

    pool = createPoolImpl(configuration.pool, {
      logger: {
        error(event) {
          const code = safeCode(
            event?.code,
            "unexpected_idle_client_error"
          );
          stderr.write(
            `${JSON.stringify({ component: "social_postgres", code })}\n`
          );
        }
      }
    });
    const runner = createRunnerImpl({
      pool,
      ownerRole: configuration.ownerRole,
      migratorRole: configuration.migratorRole,
      target: configuration.target
    });

    // Apply is deliberately unreachable until the same invocation has passed
    // the staging read-only plan. There is no automatic retry path.
    const plan = await runner.planStagingExact(loaded.request, env);
    let applied;
    if (parsed.command === "apply") {
      applied = await runner.applyStagingExact(loaded.request, env);
      applyCompleted = true;
    }
    output = {
      ok: true,
      command: parsed.command,
      packageDigest: loaded.packageDigest,
      evidenceAuthentication: Object.freeze({
        recoveryFileDigestMatched:
          loaded.evidenceAuthentication?.recoveryFileDigestMatched === true,
        recoveryLiteralsMatched:
          loaded.evidenceAuthentication?.recoveryLiteralsMatched === true,
        exportFileDigestMatched:
          loaded.evidenceAuthentication?.exportFileDigestMatched === true,
        exportLiteralsMatched:
          loaded.evidenceAuthentication?.exportLiteralsMatched === true
      }),
      plan: safePlan(plan)
    };
    if (applied) output.result = safeApply(applied);
  } catch (error) {
    operationFailure = error;
  } finally {
    if (pool) {
      try {
        await closePoolImpl(pool);
      } catch (error) {
        if (!operationFailure) {
          operationFailure = applyCompleted
            ? classifyAfterApplyFailure(error)
            : error;
        }
      }
    }
  }
  if (operationFailure) {
    stderr.write(`${JSON.stringify(failurePayload(operationFailure))}\n`);
    return 1;
  }
  try {
    stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const failure = applyCompleted ? classifyAfterApplyFailure(error) : error;
    stderr.write(`${JSON.stringify(failurePayload(failure))}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(failurePayload(error))}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  COMMANDS,
  REQUIRED_DISABLED_SOCIAL_FLAGS,
  StagingExactCliFailure,
  assertExternalIntegrationsDisabled,
  assertRepositoryMatchesPackage,
  classifyAfterApplyFailure,
  inspectRepositoryState,
  main,
  parseStagingExactCommand
};
