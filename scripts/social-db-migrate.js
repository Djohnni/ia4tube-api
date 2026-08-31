"use strict";

const {
  loadMigrationPostgresConfig
} = require("../src/persistence/postgres/config");
const {
  closePostgresPool,
  createPostgresPool
} = require("../src/persistence/postgres/pool");
const {
  COMPLIANCE_FROM_PROFILE,
  COMPLIANCE_PENDING_MIGRATIONS,
  COMPLIANCE_TO_PROFILE,
  EXACT_FROM_PROFILE,
  EXACT_PENDING_MIGRATIONS,
  EXACT_TO_PROFILE,
  REFERENCE_CHECK_FROM_PROFILE,
  REFERENCE_CHECK_PENDING_MIGRATIONS,
  REFERENCE_CHECK_TO_PROFILE,
  STAGING_EXACT_DATABASE_SERVICE_ID,
  STAGING_EXACT_WEB_SERVICE_ID,
  createMigrationRunner
} = require("../src/persistence/postgres/migrations");

const LEGACY_COMMANDS = new Set(["status", "validate", "apply"]);
const EXACT_COMMANDS = new Set(["plan-exact", "apply-exact"]);
const REFERENCE_CHECK_COMMANDS = new Set([
  "plan-reference-check-fix",
  "apply-reference-check-fix"
]);
const COMPLIANCE_COMMANDS = new Set([
  "plan-meta-compliance",
  "apply-meta-compliance"
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RECOVERY_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CLIENT_RELEASE_FAILURE = Symbol("clientReleaseFailure");
const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/;
const SAFE_DOMAIN_ERROR_CODE =
  /^(?:migration|postgres|social|production|destructive)_[a-z0-9_]+$/;
const SAFE_ERROR_NAMES = new Set([
  "AggregateError",
  "DatabaseError",
  "Error",
  "MigrationCommandFailure",
  "PostgresError",
  "RangeError",
  "ReferenceError",
  "SocialPostgresError",
  "SyntaxError",
  "TypeError",
  "URIError"
]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);
const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT"
]);

class MigrationCommandFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "MigrationCommandFailure";
  }
}

function refuse(code) {
  throw new MigrationCommandFailure(code);
}

function parseNamedArguments(args) {
  const parsed = new Map();
  for (const argument of args) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match) refuse("migration_exact_argument_invalid");
    if (parsed.has(match[1])) refuse("migration_exact_argument_duplicate");
    parsed.set(match[1], match[2]);
  }
  return parsed;
}

function parseMigrationCommand(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length < 1) {
    refuse("migration_command_invalid");
  }
  const command = String(argv[0] || "").trim().toLowerCase();
  if (LEGACY_COMMANDS.has(command)) {
    // Preserve the historical parser: legacy modes use only argv[0].
    return Object.freeze({ command, request: undefined });
  }
  if (REFERENCE_CHECK_COMMANDS.has(command)) {
    const named = parseNamedArguments(argv.slice(1));
    if (
      named.size !== 1 ||
      !named.has("migration-sha256") ||
      !SHA256_PATTERN.test(named.get("migration-sha256"))
    ) {
      refuse("migration_reference_check_argument_invalid");
    }
    return Object.freeze({
      command,
      request: Object.freeze({
        fromProfile: REFERENCE_CHECK_FROM_PROFILE,
        toProfile: REFERENCE_CHECK_TO_PROFILE,
        expectedPending: Object.freeze([
          ...REFERENCE_CHECK_PENDING_MIGRATIONS
        ]),
        migrationSha256: named.get("migration-sha256")
      })
    });
  }
  if (COMPLIANCE_COMMANDS.has(command)) {
    const named = parseNamedArguments(argv.slice(1));
    const apply = command === "apply-meta-compliance";
    const expectedNames = new Set([
      "migration-sha256",
      ...(apply
        ? [
            "recovery-reference",
            "recovery-captured-at",
            "execution-package-digest",
            "staging-approval",
            "database-marker-uuid"
          ]
        : [])
    ]);
    if (
      named.size !== expectedNames.size ||
      [...named.keys()].some((name) => !expectedNames.has(name)) ||
      [...expectedNames].some((name) => !named.has(name)) ||
      !SHA256_PATTERN.test(named.get("migration-sha256") || "")
    ) {
      refuse("migration_compliance_argument_invalid");
    }
    const request = {
      fromProfile: COMPLIANCE_FROM_PROFILE,
      toProfile: COMPLIANCE_TO_PROFILE,
      expectedPending: Object.freeze([...COMPLIANCE_PENDING_MIGRATIONS]),
      migrationSha256: named.get("migration-sha256")
    };
    if (apply) {
      request.recoveryReference = named.get("recovery-reference");
      request.recoveryCapturedAt = named.get("recovery-captured-at");
      request.executionPackageDigest = named.get("execution-package-digest");
      request.stagingApproval = named.get("staging-approval");
      request.databaseMarkerUuid = String(
        named.get("database-marker-uuid") || ""
      ).toLowerCase();
      request.recoveryStatus = "AVAILABLE";
      request.recoveryConcurrentOperation = "NONE";
      request.renderWebServiceId = STAGING_EXACT_WEB_SERVICE_ID;
      request.renderDatabaseServiceId = STAGING_EXACT_DATABASE_SERVICE_ID;
      if (
        !RECOVERY_REFERENCE.test(request.recoveryReference || "") ||
        !SHA256_PATTERN.test(request.executionPackageDigest || "") ||
        !UUID_PATTERN.test(request.databaseMarkerUuid)
      ) {
        refuse("migration_compliance_argument_invalid");
      }
      const timestamp = Date.parse(request.recoveryCapturedAt);
      const canonical = RECOVERY_TIMESTAMP.test(request.recoveryCapturedAt || "")
        ? request.recoveryCapturedAt.includes(".")
          ? request.recoveryCapturedAt
          : request.recoveryCapturedAt.replace(/Z$/, ".000Z")
        : "";
      if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString() !== canonical
      ) {
        refuse("migration_compliance_argument_invalid");
      }
    }
    return Object.freeze({ command, request: Object.freeze(request) });
  }
  if (!EXACT_COMMANDS.has(command)) refuse("migration_command_invalid");

  const named = parseNamedArguments(argv.slice(1));
  const expectedNames = new Set([
    "from-profile",
    "expect-pending",
    "to-profile",
    ...(command === "apply-exact"
      ? ["recovery-reference", "recovery-captured-at"]
      : [])
  ]);
  if (
    named.size !== expectedNames.size ||
    [...named.keys()].some((name) => !expectedNames.has(name)) ||
    [...expectedNames].some((name) => !named.has(name))
  ) {
    refuse("migration_exact_argument_set_invalid");
  }
  if (named.get("from-profile") !== EXACT_FROM_PROFILE) {
    refuse("migration_exact_from_profile_invalid");
  }
  if (named.get("to-profile") !== EXACT_TO_PROFILE) {
    refuse("migration_exact_to_profile_invalid");
  }
  if (named.get("expect-pending") !== EXACT_PENDING_MIGRATIONS[0]) {
    refuse("migration_exact_pending_migration_invalid");
  }

  const request = {
    fromProfile: EXACT_FROM_PROFILE,
    toProfile: EXACT_TO_PROFILE,
    expectedPending: Object.freeze([...EXACT_PENDING_MIGRATIONS])
  };
  if (command === "apply-exact") {
    request.recoveryReference = named.get("recovery-reference");
    request.recoveryCapturedAt = named.get("recovery-captured-at");
    if (!RECOVERY_REFERENCE.test(request.recoveryReference)) {
      refuse("migration_exact_recovery_reference_invalid");
    }
    const parsedTimestamp = Date.parse(request.recoveryCapturedAt);
    const canonicalTimestamp = RECOVERY_TIMESTAMP.test(
      request.recoveryCapturedAt
    )
      ? request.recoveryCapturedAt.includes(".")
        ? request.recoveryCapturedAt
        : request.recoveryCapturedAt.replace(/Z$/, ".000Z")
      : "";
    if (
      !Number.isFinite(parsedTimestamp) ||
      new Date(parsedTimestamp).toISOString() !== canonicalTimestamp
    ) {
      refuse("migration_exact_recovery_timestamp_invalid");
    }
  }
  return Object.freeze({ command, request: Object.freeze(request) });
}

function createFailureObservation() {
  return {
    failureStage: "argument_validation",
    connectionAttempted: null,
    connectionEstablished: null,
    authenticationObserved: null,
    queryAttempted: null,
    databaseResponseObserved: null
  };
}

function copyFailureObservation(observation) {
  return Object.freeze({
    failureStage: observation.failureStage,
    connectionAttempted: observation.connectionAttempted,
    connectionEstablished: observation.connectionEstablished,
    authenticationObserved: observation.authenticationObserved,
    queryAttempted: observation.queryAttempted,
    databaseResponseObserved: observation.databaseResponseObserved
  });
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : null;
}

function postgresSqlstate(error) {
  const code = errorCode(error);
  return code &&
    !NETWORK_ERROR_CODES.has(code) &&
    !TLS_ERROR_CODES.has(code) &&
    !code.startsWith("ERR_TLS_") &&
    POSTGRES_SQLSTATE.test(code)
    ? code
    : null;
}

function safeErrorName(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  return SAFE_ERROR_NAMES.has(name) ? name : "Error";
}

function safeCauseCategory(error) {
  const code = errorCode(error);
  if (code === null) return "exception_without_string_code";
  if (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_")) {
    return "tls_error";
  }
  if (NETWORK_ERROR_CODES.has(code)) return "network_error";
  if (postgresSqlstate(error)) return "postgresql_sqlstate";
  if (SAFE_DOMAIN_ERROR_CODE.test(code)) return "application_error";
  return "exception_with_unrecognized_string_code";
}

function publicFailureCode(error) {
  const code = errorCode(error);
  return code && SAFE_DOMAIN_ERROR_CODE.test(code)
    ? code
    : "migration_command_failed";
}

function refineObservationForError(error, observation) {
  const code = errorCode(error);
  const sqlstate = postgresSqlstate(error);
  if (sqlstate) {
    observation.databaseResponseObserved = true;
    if (sqlstate.startsWith("28")) {
      observation.authenticationObserved = true;
      if (observation.failureStage === "connection_attempt") {
        observation.failureStage = "authentication";
      }
    }
  }
  if (
    code &&
    (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_")) &&
    observation.failureStage === "connection_attempt"
  ) {
    observation.failureStage = "tls_verification";
  }
}

function failureEnvelope(error, observation) {
  const snapshot = { ...observation };
  refineObservationForError(error, snapshot);
  const failure = {
    ok: false,
    code: publicFailureCode(error),
    failureStage: snapshot.failureStage,
    safeCauseCategory: safeCauseCategory(error),
    errorName: safeErrorName(error)
  };
  const sqlstate = postgresSqlstate(error);
  if (sqlstate) failure.sqlstate = sqlstate;
  failure.connectionAttempted = snapshot.connectionAttempted;
  failure.connectionEstablished = snapshot.connectionEstablished;
  failure.authenticationObserved = snapshot.authenticationObserved;
  failure.queryAttempted = snapshot.queryAttempted;
  failure.databaseResponseObserved = snapshot.databaseResponseObserved;
  if (error?.applied === true) failure.applied = true;
  if (error?.outcomeUnknown === true) failure.outcomeUnknown = true;
  if (error?.retryAllowed === false) failure.retryAllowed = false;
  if (error?.requiresReadOnlyInspection === true) {
    failure.requiresReadOnlyInspection = true;
  }
  return Object.freeze(failure);
}

function queryFailureStage(query) {
  const text = typeof query === "string" ? query : String(query?.text || "");
  if (/to_regclass|schema_migrations|checksum_sha256|execution_ms/i.test(text)) {
    return "ledger_read";
  }
  if (
    /server_version_num|session_user|current_user|set\s+local\s+role|pg_has_role|pg_auth_members|pg_roles/i.test(
      text
    )
  ) {
    return "identity_role_verification";
  }
  return "plan_construction";
}

function observeClient(client, observation) {
  return Object.freeze({
    async query(...args) {
      observation.failureStage = queryFailureStage(args[0]);
      observation.queryAttempted = true;
      try {
        const result = await client.query(...args);
        observation.databaseResponseObserved = true;
        return result;
      } catch (error) {
        refineObservationForError(error, observation);
        throw error;
      }
    },
    release(...args) {
      const activeStage = observation.failureStage;
      try {
        const result = client.release(...args);
        observation.failureStage = activeStage;
        return result;
      } catch (error) {
        if (!observation[CLIENT_RELEASE_FAILURE]) {
          observation[CLIENT_RELEASE_FAILURE] = error;
        }
        observation.failureStage = activeStage;
        return undefined;
      }
    }
  });
}

function observePool(pool, observation) {
  return Object.freeze({
    async connect(...args) {
      observation.failureStage = "connection_attempt";
      observation.connectionAttempted = true;
      try {
        const client = await pool.connect(...args);
        observation.failureStage = "connection_established";
        observation.connectionEstablished = true;
        observation.authenticationObserved = true;
        observation.databaseResponseObserved = true;
        return observeClient(client, observation);
      } catch (error) {
        refineObservationForError(error, observation);
        throw error;
      }
    }
  });
}

function commandExecutionStage(command) {
  return command.includes("plan") || command.includes("apply")
    ? "plan_construction"
    : "command_execution";
}

function capturedFailure(error, observation, status) {
  return Object.freeze({
    error,
    observation: copyFailureObservation(observation),
    status
  });
}

async function completeRunnerOperation(operation, observation) {
  const result = await operation;
  if (observation[CLIENT_RELEASE_FAILURE]) {
    observation.failureStage = "finalization";
    throw observation[CLIENT_RELEASE_FAILURE];
  }
  return result;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  PoolClass,
  createPoolImpl = (poolConfig, options) =>
    createPostgresPool(poolConfig, { ...options, PoolClass }),
  closePoolImpl = closePostgresPool,
  createRunnerImpl = createMigrationRunner,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const observation = createFailureObservation();
  let parsed;
  try {
    parsed = parseMigrationCommand(argv);
  } catch (error) {
    stderr.write(`${JSON.stringify(failureEnvelope(error, observation))}\n`);
    return 2;
  }

  let pool;
  let failure;
  let serializedSuccess;
  try {
    observation.failureStage = "environment_validation";
    const configuration = loadMigrationPostgresConfig(env);
    observation.failureStage = "pool_creation";
    pool = createPoolImpl(configuration.pool, {
      logger: {
        error() {
          // Keep stderr single-line and self-contained for the terminal result.
        }
      }
    });
    observation.failureStage = "runner_creation";
    const runner = createRunnerImpl({
      pool: observePool(pool, observation),
      ownerRole: configuration.ownerRole,
      migratorRole: configuration.migratorRole,
      target: configuration.target
    });

    observation.failureStage = commandExecutionStage(parsed.command);
    let result;
    if (parsed.command === "status") {
      result = await completeRunnerOperation(runner.inspect(), observation);
    }
    if (parsed.command === "validate") {
      result = await completeRunnerOperation(runner.validate(), observation);
    }
    if (parsed.command === "apply") {
      result = await completeRunnerOperation(runner.apply(env), observation);
    }
    if (parsed.command === "plan-reference-check-fix") {
      result = await completeRunnerOperation(
        runner.planReferenceCheckFix(parsed.request, env),
        observation
      );
    }
    if (parsed.command === "apply-reference-check-fix") {
      await completeRunnerOperation(
        runner.planReferenceCheckFix(parsed.request, env),
        observation
      );
      result = await completeRunnerOperation(
        runner.applyReferenceCheckFix(parsed.request, env),
        observation
      );
    }
    if (parsed.command === "plan-meta-compliance") {
      result = await completeRunnerOperation(
        runner.planMetaCompliance(parsed.request, env),
        observation
      );
    }
    if (parsed.command === "apply-meta-compliance") {
      await completeRunnerOperation(
        runner.planMetaCompliance(parsed.request, env),
        observation
      );
      result = await completeRunnerOperation(
        runner.applyMetaCompliance(parsed.request, env),
        observation
      );
    }
    if (parsed.command === "plan-exact") {
      result = await completeRunnerOperation(
        runner.planExact(parsed.request, env),
        observation
      );
    }
    if (parsed.command === "apply-exact") {
      result = await completeRunnerOperation(
        runner.applyExact(parsed.request, env),
        observation
      );
    }
    observation.failureStage = "result_serialization";
    const output = { ok: true, command: parsed.command, result };
    serializedSuccess =
      `${JSON.stringify(output, null, LEGACY_COMMANDS.has(parsed.command) ? 2 : 0)}\n`;
  } catch (error) {
    failure = capturedFailure(error, observation, 1);
  }

  if (pool) {
    observation.failureStage = "finalization";
    try {
      await closePoolImpl(pool);
    } catch (error) {
      if (!failure) failure = capturedFailure(error, observation, 1);
    }
  }

  if (failure) {
    stderr.write(
      `${JSON.stringify(failureEnvelope(
        failure.error,
        failure.observation
      ))}\n`
    );
    return failure.status;
  }

  observation.failureStage = "result_output";
  try {
    stdout.write(serializedSuccess);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(failureEnvelope(error, observation))}\n`);
    return 1;
  }
}

if (require.main === module) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      const observation = createFailureObservation();
      observation.failureStage = "finalization";
      process.stderr.write(
        `${JSON.stringify(failureEnvelope(error, observation))}\n`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  LEGACY_COMMANDS,
  COMPLIANCE_COMMANDS,
  REFERENCE_CHECK_COMMANDS,
  MigrationCommandFailure,
  parseMigrationCommand,
  main
};
