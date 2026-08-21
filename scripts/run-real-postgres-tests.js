"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const APPROVAL = "RUN_SOCIAL_POSTGRES_REAL_TESTS";
const REMOTE_APPROVAL = "RUN_SOCIAL_POSTGRES_RENDER_FREE_DISPOSABLE";
const PAID_STAGING_DISPOSABLE_APPROVAL =
  "RUN_SOCIAL_POSTGRES_RENDER_PAID_STAGING_DISPOSABLE";
const LOOPBACK_MODE = "loopback";
const RENDER_REMOTE_MODE = "render_free_remote";
const RENDER_PAID_STAGING_DISPOSABLE_MODE =
  "render_paid_staging_disposable";
const REMOTE_DATABASE = "ia4tube_social_2b0_gate";
const REQUIRED = [
  "SOCIAL_TEST_ENVIRONMENT_ID",
  "SOCIAL_TEST_PROVISIONER_DATABASE_URL",
  "SOCIAL_TEST_MIGRATION_DATABASE_URL",
  "SOCIAL_TEST_RUNTIME_DATABASE_URL"
];
const REMOTE_EXPECTED = [
  "SOCIAL_TEST_EXPECTED_HOST",
  "SOCIAL_TEST_EXPECTED_PORT",
  "SOCIAL_TEST_EXPECTED_DATABASE",
  "SOCIAL_TEST_EXPECTED_PROVISIONER_USERNAME",
  "SOCIAL_TEST_EXPECTED_MIGRATION_USERNAME",
  "SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME",
  "SOCIAL_TEST_EXPECTED_TARGET_FINGERPRINT"
];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BLOCKED_LABEL =
  /(^|[-_.])(prod|production|stage|staging|live|main)([-_.]|$)/i;
const PRODUCTION_LABEL =
  /(^|[-_.])(prod|production|live|main)([-_.]|$)/i;
const CONNECTION_NAMES = [
  "SOCIAL_TEST_PROVISIONER_DATABASE_URL",
  "SOCIAL_TEST_MIGRATION_DATABASE_URL",
  "SOCIAL_TEST_RUNTIME_DATABASE_URL"
];
const EVIDENCE_SCHEMA_VERSION = 6;
const EXACT_0004_ARTIFACT_SCHEMA_VERSION = 2;
const EXACT_0004_CHECKPOINT_SCHEMA_VERSION = 1;
const EXACT_0004_CHECKPOINT_KEYS = Object.freeze([
  "checkpointSchemaVersion",
  "physicalStepAdmitted",
  "physicalStepEntered",
  "physicalScriptLoadAttempted",
  "physicalScriptLoaded",
  "physicalLauncherSpawnAttempted",
  "physicalLauncherProcessCreated",
  "physicalLauncherExitCode",
  "physicalLauncherSignal",
  "physicalLauncherTimedOut",
  "postgresStartAttempted",
  "postgresStarted",
  "nodeTestSpawnAttempted",
  "nodeTestProcessCreated",
  "cleanupStarted",
  "cleanupCompleted",
  "auxiliaryProcessCount",
  "safeAuxiliaryProcessClass",
  "auxiliaryProcessOwnedByRoute",
  "firstFailureStage"
]);
const EXACT_0004_AUXILIARY_PROCESS_CLASSES = Object.freeze([
  "node",
  "sudo",
  "timeout",
  "nsenter",
  "docker",
  "postgres",
  "shell",
  "github_runner_tool",
  "other_allowlisted",
  "unknown",
  "not_observed"
]);
const EXACT_0004_CHECKPOINT_FAILURE_STAGES = Object.freeze([
  "physical_admission",
  "physical_entry",
  "physical_script_load",
  "physical_launcher_spawn",
  "postgres_start",
  "postgres_bootstrap",
  "composed_process",
  "npm",
  "runner_load",
  "environment_gate",
  "node_test_spawn",
  "node_test_bootstrap",
  "tap_start",
  "test_discovery",
  "test_execution",
  "safe_event_protocol",
  "physical_timeout",
  "cleanup",
  "artifact",
  "physical_evidence",
  "unknown"
]);
const EXACT_0004_PHYSICAL_FAILURE_CODES = Object.freeze([
  "physical_step_not_admitted",
  "physical_step_command_resolution_failed_prestart",
  "physical_step_script_load_failed_prestart",
  "physical_step_launcher_spawn_failed",
  "physical_step_process_created_before_evidence_failure",
  "physical_step_evidence_writer_failed",
  "physical_step_cleanup_not_started",
  "physical_step_cleanup_incomplete_with_owned_auxiliary_process",
  "physical_step_auxiliary_process_not_owned_by_route",
  "physical_step_failure_evidence_insufficient"
]);
const EXACT_0004_CLEANUP_FAILURE_CODES = Object.freeze([
  "physical_cleanup_incomplete",
  "final_cleanup_state_missing",
  "final_cleanup_state_partial",
  "final_cleanup_state_invalid",
  "final_cleanup_incomplete",
  "final_residuals_nonzero"
]);
const SAFE_EVENT_PREFIX = "IA4TUBE_SAFE_EVENT=";
const TAP_TITLE =
  "real PostgreSQL proves migrations, physical RLS, vault and reauthentication";
const TAP_SUBTEST_TITLE = `# Subtest: ${TAP_TITLE}`;
const SAFE_OUTPUT_LIMIT = 16 * 1024 * 1024;
const SAFE_LINE_LIMIT = 8192;
const PHYSICAL_MAIN_PHASES = Object.freeze([
  "physical_target_preflight",
  "role_provisioning",
  "direct_connect_boundary",
  "startup_unmigrated",
  "migration_0001_0002",
  "pre_registry_seed",
  "migration_0003_rollback",
  "migration_0003_apply",
  "exact_0004_plan_apply",
  "post_migration_validation",
  "migration_cli",
  "runtime_role_schema",
  "runtime_permission_negatives",
  "tenant_rls",
  "vault_persistence",
  "reauthentication"
]);
const PHYSICAL_CLEANUP_PHASE = "final_cleanup";
const PHYSICAL_PHASES = Object.freeze([
  ...PHYSICAL_MAIN_PHASES,
  PHYSICAL_CLEANUP_PHASE
]);
const EXACT_0004_SUBPHASES = Object.freeze([
  "oid_catalog_lookup",
  "direct_privilege_boolean_check",
  "direct_ledger_read_negative",
  "set_local_migrator_role",
  "role_ledger_read_positive",
  "snapshot_before_plan",
  "plan_exact",
  "plan_snapshot_compare",
  "synthetic_0005_negative",
  "conflicting_0004_negative",
  "rollback_verification",
  "conflicting_external_account_0004_negative",
  "external_account_rollback_verification",
  "apply_exact",
  "concurrency",
  "final_snapshot",
  "unknown",
  "not_reached"
]);
const EXACT_0004_EXECUTION_SUBPHASES = Object.freeze(
  EXACT_0004_SUBPHASES.slice(0, -2)
);
const EXACT_0004_OPERATION_CLASSES = Object.freeze([
  "catalog_read",
  "privilege_check",
  "direct_negative_read",
  "role_switch",
  "role_positive_read",
  "schema_snapshot",
  "plan",
  "negative_gate",
  "rollback_check",
  "apply",
  "concurrency",
  "final_validation",
  "unknown"
]);
const EXACT_0004_ERROR_CLASSES = Object.freeze([
  "postgres_sqlstate",
  "assertion_failure",
  "environment_contract",
  "process_failure",
  "timeout",
  "unexpected_result",
  "unknown"
]);
const SAFE_SQL_STATES = Object.freeze(["42501", "23514", "P0001"]);
const SAFE_SQL_STATE_VALUES = Object.freeze([
  ...SAFE_SQL_STATES,
  "unknown",
  "not_observed"
]);
const POSTGRES_SQL_STATE = /^[0-9A-Z]{5}$/;
const CONFLICTING_NEGATIVE_PROMISE_OUTCOMES = Object.freeze([
  "not_started",
  "fulfilled",
  "rejected",
  "unknown"
]);
const CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES = Object.freeze([
  "not_observed",
  "empty",
  "applied_0004",
  "other",
  "unknown"
]);
const EXACT_0004_EVIDENCE_FIELDS = Object.freeze([
  "lastExact0004SubphaseStarted",
  "lastExact0004SubphaseCompleted",
  "exact0004FailureSubphase",
  "safeSqlState",
  "safeErrorClass",
  "safeOperationClass",
  "planExactInvoked",
  "planExactCompleted",
  "applyExactInvoked",
  "applyExactCompleted",
  "databaseMutationAttempted",
  "failureBeforeFirstMutation",
  "conflictingNegativeAttempted",
  "conflictingNegativePromiseOutcome",
  "conflictingNegativeObservedSqlState",
  "conflictingNegativeFulfilledResultClass",
  "conflictingNegativeAssertionMatched",
  "conflictingNegativeRejectedBeforeAssertion"
]);
const EXACT_0004_OPERATION_BY_SUBPHASE = Object.freeze({
  oid_catalog_lookup: "catalog_read",
  direct_privilege_boolean_check: "privilege_check",
  direct_ledger_read_negative: "direct_negative_read",
  set_local_migrator_role: "role_switch",
  role_ledger_read_positive: "role_positive_read",
  snapshot_before_plan: "schema_snapshot",
  plan_exact: "plan",
  plan_snapshot_compare: "schema_snapshot",
  synthetic_0005_negative: "negative_gate",
  conflicting_0004_negative: "negative_gate",
  rollback_verification: "rollback_check",
  conflicting_external_account_0004_negative: "negative_gate",
  external_account_rollback_verification: "rollback_check",
  apply_exact: "apply",
  concurrency: "concurrency",
  final_snapshot: "final_validation",
  unknown: "unknown",
  not_reached: "unknown"
});
const SAFE_PERMISSION_CODES = Object.freeze(["42501", "EACCES", "EPERM"]);
const SAFE_PERMISSION_ORIGINS = Object.freeze([
  "postgres_sqlstate",
  "os_filesystem",
  "os_process",
  "unknown"
]);
const SAFE_SOURCE_BASENAMES = Object.freeze([
  "social-postgres-real.test.js",
  "migrations.js",
  "pool.js",
  "runtime-validation.js",
  "social-repository.js",
  "vault-key-registry-admin.js",
  "credential-service.js",
  "reauth.js",
  "vault.js",
  "vault-key-rotation-service.js",
  "server.js"
]);
const SAFE_LINE_BUCKETS = Object.freeze([
  "1-499",
  "500-999",
  "1000-1499",
  "1500-1999",
  "2000-2499",
  "2500-2999",
  "3000-3499",
  "3500-3999",
  "4000-4499",
  "unknown"
]);
const FILESYSTEM_SYSCALLS = Object.freeze([
  "access",
  "chmod",
  "chown",
  "copyfile",
  "link",
  "lstat",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "read",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rmdir",
  "stat",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "write"
]);
const PROCESS_SYSCALLS = Object.freeze([
  "exec",
  "execfile",
  "execve",
  "fork",
  "kill",
  "spawn",
  "spawnsync"
]);
const STDERR_CATEGORIES = Object.freeze([
  "npm_script_missing",
  "module_not_found",
  "syntax_error",
  "reference_error",
  "type_error",
  "permission_denied",
  "connection_refused",
  "tls_hostname",
  "environment_contract",
  "postgres_authentication",
  "postgres_schema",
  "tap_failure",
  "unknown"
]);
const FIRST_FAILURE_STAGES = Object.freeze([
  "postgres_start",
  "postgres_bootstrap",
  "composed_process",
  "npm",
  "runner_load",
  "environment_gate",
  "node_test_spawn",
  "node_test_bootstrap",
  "tap_start",
  "test_discovery",
  "test_execution",
  "safe_event_protocol",
  "physical_timeout",
  "cleanup",
  "artifact",
  "unknown"
]);
const SAFE_ERROR_CODES = Object.freeze([
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "EACCES",
  "EPERM",
  "ECONNREFUSED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "28P01",
  "3F000",
  "42P01",
  "42703",
  "42501",
  "23514",
  "P0001",
  "ERR_TEST_FAILURE",
  "guard_failed",
  "test_process_failed",
  "safe_output_limit_exceeded",
  "safe_event_protocol_invalid",
  "tap_contract_failed",
  "test_timeout"
]);
const SAFE_MODULE_NAMES = Object.freeze([
  "social-postgres-real.test.js",
  "run-real-postgres-tests.js",
  "bcryptjs",
  "pg",
  "config.js",
  "tls.js",
  "staging-provisioner.js",
  "disposable-database-lifecycle.js",
  "login-bootstrap.js",
  "errors.js",
  "validation.js",
  "migrations.js",
  "pool.js",
  "runtime-validation.js",
  "social-repository.js",
  "vault-key-registry-admin.js",
  "credential-service.js",
  "reauth.js",
  "vault.js",
  "vault-key-version.js",
  "vault-key-rotation-service.js"
]);
const SAFE_SIGNALS = new Set([
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTRAP"
]);
const STDERR_CATEGORY_SET = new Set(STDERR_CATEGORIES);
const FIRST_FAILURE_STAGE_SET = new Set(FIRST_FAILURE_STAGES);
const SAFE_ERROR_CODE_SET = new Set(SAFE_ERROR_CODES);
const SAFE_MODULE_NAME_SET = new Set(SAFE_MODULE_NAMES);
const PHYSICAL_MAIN_PHASE_SET = new Set(PHYSICAL_MAIN_PHASES);
const PHYSICAL_BOUNDARY_FAILURE_STAGE_SET = new Set([
  "safe_event_protocol",
  "test_execution"
]);
const SAFE_PERMISSION_CODE_SET = new Set(SAFE_PERMISSION_CODES);
const SAFE_PERMISSION_ORIGIN_SET = new Set(SAFE_PERMISSION_ORIGINS);
const SAFE_SOURCE_BASENAME_SET = new Set(SAFE_SOURCE_BASENAMES);
const SAFE_LINE_BUCKET_SET = new Set(SAFE_LINE_BUCKETS);
const EXACT_0004_SUBPHASE_SET = new Set(EXACT_0004_SUBPHASES);
const EXACT_0004_OPERATION_CLASS_SET = new Set(
  EXACT_0004_OPERATION_CLASSES
);
const EXACT_0004_ERROR_CLASS_SET = new Set(EXACT_0004_ERROR_CLASSES);
const SAFE_SQL_STATE_SET = new Set(SAFE_SQL_STATES);
const SAFE_SQL_STATE_VALUE_SET = new Set(SAFE_SQL_STATE_VALUES);
const CONFLICTING_NEGATIVE_PROMISE_OUTCOME_SET = new Set(
  CONFLICTING_NEGATIVE_PROMISE_OUTCOMES
);
const CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASS_SET = new Set(
  CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES
);
const FILESYSTEM_SYSCALL_SET = new Set(FILESYSTEM_SYSCALLS);
const PROCESS_SYSCALL_SET = new Set(PROCESS_SYSCALLS);
let cachedGateDependencies;

function gateDependencies() {
  if (cachedGateDependencies) return cachedGateDependencies;
  const {
    assertNoAmbientPostgresEnvironment
  } = require("../src/persistence/postgres/config");
  const {
    loadSystemPostgresTls
  } = require("../src/persistence/postgres/tls");
  const {
    PAID_STAGING_PUBLIC_TARGET
  } = require("../src/persistence/postgres/staging-provisioner");
  const {
    DISPOSABLE_DATABASE_NAME
  } = require("../src/persistence/postgres/disposable-database-lifecycle");
  cachedGateDependencies = Object.freeze({
    assertNoAmbientPostgresEnvironment,
    loadSystemPostgresTls,
    PAID_STAGING_PUBLIC_TARGET,
    DISPOSABLE_DATABASE_NAME
  });
  return cachedGateDependencies;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function nullableMainPhase(value) {
  return value === null || PHYSICAL_MAIN_PHASE_SET.has(value);
}

function safeSourceFieldsValid(basename, bucket) {
  if (!SAFE_LINE_BUCKET_SET.has(bucket)) return false;
  if (basename === null) return bucket === "unknown";
  return SAFE_SOURCE_BASENAME_SET.has(basename);
}

function emptyConflictingNegativeEvidence() {
  return Object.freeze({
    conflictingNegativeAttempted: false,
    conflictingNegativePromiseOutcome: "not_started",
    conflictingNegativeObservedSqlState: "not_observed",
    conflictingNegativeFulfilledResultClass: "not_observed",
    conflictingNegativeAssertionMatched: null,
    conflictingNegativeRejectedBeforeAssertion: null
  });
}

function sanitizedPostgresSqlState(error) {
  try {
    const code = error?.code;
    return typeof code === "string" && POSTGRES_SQL_STATE.test(code)
      ? code
      : "unknown";
  } catch {
    return "unknown";
  }
}

function conflictingNegativeFulfilledResultClass(value) {
  if (value === undefined || value === null) return "empty";
  try {
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "appliedMigration") &&
      value.appliedMigration === "0004_social_connector_persistence"
    ) return "applied_0004";
  } catch {
    return "unknown";
  }
  return "other";
}

function conflictingNegativeEvidenceValid(value) {
  if (
    typeof value.conflictingNegativeAttempted !== "boolean" ||
    !CONFLICTING_NEGATIVE_PROMISE_OUTCOME_SET.has(
      value.conflictingNegativePromiseOutcome
    ) ||
    typeof value.conflictingNegativeObservedSqlState !== "string" ||
    !(
      value.conflictingNegativeObservedSqlState === "not_observed" ||
      value.conflictingNegativeObservedSqlState === "unknown" ||
      POSTGRES_SQL_STATE.test(value.conflictingNegativeObservedSqlState)
    ) ||
    !CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASS_SET.has(
      value.conflictingNegativeFulfilledResultClass
    ) ||
    ![
      true,
      false,
      null
    ].includes(value.conflictingNegativeAssertionMatched) ||
    ![
      true,
      false,
      null
    ].includes(value.conflictingNegativeRejectedBeforeAssertion)
  ) return false;
  if (!value.conflictingNegativeAttempted) {
    return value.conflictingNegativePromiseOutcome === "not_started" &&
      value.conflictingNegativeObservedSqlState === "not_observed" &&
      value.conflictingNegativeFulfilledResultClass === "not_observed" &&
      value.conflictingNegativeAssertionMatched === null &&
      value.conflictingNegativeRejectedBeforeAssertion === null;
  }
  if (value.conflictingNegativePromiseOutcome === "unknown") {
    return value.conflictingNegativeObservedSqlState === "unknown" &&
      value.conflictingNegativeFulfilledResultClass === "unknown" &&
      value.conflictingNegativeAssertionMatched === null &&
      value.conflictingNegativeRejectedBeforeAssertion === null;
  }
  if (value.conflictingNegativePromiseOutcome === "fulfilled") {
    return value.conflictingNegativeObservedSqlState === "not_observed" &&
      [
        "empty",
        "applied_0004",
        "other",
        "unknown"
      ].includes(value.conflictingNegativeFulfilledResultClass) &&
      value.conflictingNegativeAssertionMatched === null &&
      value.conflictingNegativeRejectedBeforeAssertion === false;
  }
  if (value.conflictingNegativePromiseOutcome !== "rejected") return false;
  const observedSqlState = value.conflictingNegativeObservedSqlState;
  const observedSqlStateValid = observedSqlState === "unknown" ||
    POSTGRES_SQL_STATE.test(observedSqlState);
  const assertionMatched = value.conflictingNegativeAssertionMatched;
  return observedSqlStateValid &&
    value.conflictingNegativeFulfilledResultClass === "not_observed" &&
    value.conflictingNegativeRejectedBeforeAssertion === true &&
    (assertionMatched === null ||
      assertionMatched === (observedSqlState === "23514"));
}

function conflictingNegativeSucceeded(value) {
  return value.conflictingNegativeAttempted === true &&
    value.conflictingNegativePromiseOutcome === "rejected" &&
    value.conflictingNegativeObservedSqlState === "23514" &&
    value.conflictingNegativeFulfilledResultClass === "not_observed" &&
    value.conflictingNegativeAssertionMatched === true &&
    value.conflictingNegativeRejectedBeforeAssertion === true;
}

function emptyExact0004Evidence({ failureObserved = false } = {}) {
  return Object.freeze({
    lastExact0004SubphaseStarted: "not_reached",
    lastExact0004SubphaseCompleted: "not_reached",
    exact0004FailureSubphase: "not_reached",
    safeSqlState: failureObserved ? "unknown" : "not_observed",
    safeErrorClass: "unknown",
    safeOperationClass: "unknown",
    planExactInvoked: false,
    planExactCompleted: false,
    applyExactInvoked: false,
    applyExactCompleted: false,
    databaseMutationAttempted: false,
    failureBeforeFirstMutation: false,
    ...emptyConflictingNegativeEvidence()
  });
}

function exact0004OperationClass(subphase) {
  return EXACT_0004_OPERATION_BY_SUBPHASE[subphase] || "unknown";
}

function exact0004ProgressValid(value) {
  const started = value.lastExact0004SubphaseStarted;
  const completed = value.lastExact0004SubphaseCompleted;
  if (started === "not_reached") return completed === "not_reached";
  if (started === "unknown") {
    return completed === "unknown" || completed === "not_reached";
  }
  const startedIndex = EXACT_0004_EXECUTION_SUBPHASES.indexOf(started);
  if (startedIndex < 0) return false;
  if (completed === "not_reached") return startedIndex === 0;
  const completedIndex = EXACT_0004_EXECUTION_SUBPHASES.indexOf(completed);
  return completedIndex >= 0 &&
    (startedIndex === completedIndex || startedIndex === completedIndex + 1);
}

function exact0004EvidenceValid(value, { failureEvent = false } = {}) {
  if (
    !EXACT_0004_SUBPHASE_SET.has(value.lastExact0004SubphaseStarted) ||
    !EXACT_0004_SUBPHASE_SET.has(value.lastExact0004SubphaseCompleted) ||
    !EXACT_0004_SUBPHASE_SET.has(value.exact0004FailureSubphase) ||
    !SAFE_SQL_STATE_VALUE_SET.has(value.safeSqlState) ||
    !EXACT_0004_ERROR_CLASS_SET.has(value.safeErrorClass) ||
    !EXACT_0004_OPERATION_CLASS_SET.has(value.safeOperationClass) ||
    !conflictingNegativeEvidenceValid(value) ||
    !exact0004ProgressValid(value)
  ) return false;
  for (const field of [
    "planExactInvoked",
    "planExactCompleted",
    "applyExactInvoked",
    "applyExactCompleted",
    "databaseMutationAttempted",
    "failureBeforeFirstMutation"
  ]) {
    if (typeof value[field] !== "boolean") return false;
  }
  if (
    (value.planExactCompleted && !value.planExactInvoked) ||
    (value.applyExactCompleted && !value.applyExactInvoked) ||
    (value.applyExactInvoked && !value.planExactCompleted) ||
    (value.applyExactInvoked && !value.databaseMutationAttempted) ||
    (value.failureBeforeFirstMutation && value.databaseMutationAttempted) ||
    (value.conflictingNegativeAttempted &&
      !value.databaseMutationAttempted)
  ) return false;
  const started = value.lastExact0004SubphaseStarted;
  const completed = value.lastExact0004SubphaseCompleted;
  const startedIndex = EXACT_0004_EXECUTION_SUBPHASES.indexOf(started);
  const completedIndex = EXACT_0004_EXECUTION_SUBPHASES.indexOf(completed);
  if (started === "not_reached" && (
    value.planExactInvoked || value.planExactCompleted ||
    value.applyExactInvoked || value.applyExactCompleted ||
    value.databaseMutationAttempted || value.conflictingNegativeAttempted
  )) return false;
  if (started === "unknown" && value.conflictingNegativeAttempted) return false;
  if (startedIndex >= 0) {
    const planIndex = EXACT_0004_EXECUTION_SUBPHASES.indexOf("plan_exact");
    const conflictIndex = EXACT_0004_EXECUTION_SUBPHASES.indexOf(
      "conflicting_0004_negative"
    );
    const applyIndex = EXACT_0004_EXECUTION_SUBPHASES.indexOf("apply_exact");
    if (
      value.planExactInvoked !== (startedIndex >= planIndex) ||
      value.planExactCompleted !== (completedIndex >= planIndex) ||
      value.applyExactInvoked !== (startedIndex >= applyIndex) ||
      value.applyExactCompleted !== (completedIndex >= applyIndex) ||
      (startedIndex < conflictIndex && value.databaseMutationAttempted) ||
      ((startedIndex > conflictIndex || completedIndex >= conflictIndex) &&
        !value.databaseMutationAttempted) ||
      (startedIndex < conflictIndex && value.conflictingNegativeAttempted) ||
      ((startedIndex > conflictIndex || completedIndex >= conflictIndex) &&
        !conflictingNegativeSucceeded(value))
    ) return false;
  }
  const failureSubphase = value.exact0004FailureSubphase;
  const failureIndex = EXACT_0004_EXECUTION_SUBPHASES.indexOf(failureSubphase);
  if (
    value.safeOperationClass !== exact0004OperationClass(failureSubphase) ||
    (failureIndex >= 0 && (
      started !== failureSubphase || startedIndex !== completedIndex + 1
    )) ||
    (failureSubphase === "not_reached" && (
      value.failureBeforeFirstMutation ||
      value.safeSqlState !== "not_observed" ||
      value.safeErrorClass !== "unknown"
    )) ||
    (failureSubphase !== "not_reached" &&
      value.failureBeforeFirstMutation !== !value.databaseMutationAttempted)
  ) return false;
  const observedSqlState = SAFE_SQL_STATE_SET.has(value.safeSqlState);
  if (
    (observedSqlState && ![
      "postgres_sqlstate",
      "assertion_failure"
    ].includes(value.safeErrorClass)) ||
    (!observedSqlState && value.safeErrorClass === "postgres_sqlstate") ||
    (value.safeSqlState === "not_observed" &&
      value.safeErrorClass !== "unknown") ||
    (failureEvent && failureSubphase !== "not_reached" &&
      value.safeSqlState === "not_observed")
  ) return false;
  return true;
}

function physicalSnapshotValid(event) {
  if (!exactKeys(event, [
    "cleanupCompleted",
    "cleanupStarted",
    "event",
    "evidenceSchemaVersion",
    "lastMainPhaseCompleted",
    "lastMainPhaseStarted",
    "sequence",
    ...EXACT_0004_EVIDENCE_FIELDS
  ])) return false;
  if (
    !nullableMainPhase(event.lastMainPhaseStarted) ||
    !nullableMainPhase(event.lastMainPhaseCompleted) ||
    typeof event.cleanupStarted !== "boolean" ||
    typeof event.cleanupCompleted !== "boolean" ||
    (event.cleanupCompleted && !event.cleanupStarted)
  ) return false;
  const startedIndex = event.lastMainPhaseStarted === null
    ? -1
    : PHYSICAL_MAIN_PHASES.indexOf(event.lastMainPhaseStarted);
  const completedIndex = event.lastMainPhaseCompleted === null
    ? -1
    : PHYSICAL_MAIN_PHASES.indexOf(event.lastMainPhaseCompleted);
  const mainProgress = startedIndex - completedIndex;
  if (mainProgress !== 0 && mainProgress !== 1) return false;
  const mainActive = mainProgress === 1;
  const allMainCompleted =
    startedIndex === PHYSICAL_MAIN_PHASES.length - 1 &&
    completedIndex === PHYSICAL_MAIN_PHASES.length - 1;
  if (
    event.cleanupStarted &&
    !mainActive &&
    !allMainCompleted
  ) return false;
  const exactMainIndex = PHYSICAL_MAIN_PHASES.indexOf(
    "exact_0004_plan_apply"
  );
  const exactMainActive =
    startedIndex === exactMainIndex && completedIndex === exactMainIndex - 1;
  if (
    !exact0004EvidenceValid(event) ||
    (startedIndex < exactMainIndex && EXACT_0004_EVIDENCE_FIELDS.some(
      (field) => event[field] !== emptyExact0004Evidence()[field]
    )) ||
    (exactMainActive && (
      event.exact0004FailureSubphase === "not_reached" ||
      event.safeSqlState === "not_observed"
    )) ||
    (completedIndex >= exactMainIndex && (
      event.lastExact0004SubphaseStarted !== "final_snapshot" ||
      event.lastExact0004SubphaseCompleted !== "final_snapshot" ||
      event.exact0004FailureSubphase !== "not_reached" ||
      event.safeSqlState !== "not_observed" ||
      event.safeErrorClass !== "unknown" ||
      event.safeOperationClass !== "unknown" ||
      event.planExactInvoked !== true ||
      event.planExactCompleted !== true ||
      event.applyExactInvoked !== true ||
      event.applyExactCompleted !== true ||
      event.databaseMutationAttempted !== true ||
      event.failureBeforeFirstMutation !== false ||
      !conflictingNegativeSucceeded(event)
    ))
  ) return false;
  return true;
}

function failureFieldsValid(event) {
  if (
    !exact0004EvidenceValid(event, { failureEvent: true }) ||
    typeof event.failureDuringCleanup !== "boolean" ||
    !(
      event.failurePhase === null ||
      PHYSICAL_MAIN_PHASE_SET.has(event.failurePhase) ||
      event.failurePhase === PHYSICAL_CLEANUP_PHASE
    ) ||
    !SAFE_PERMISSION_ORIGIN_SET.has(event.safePermissionOrigin) ||
    !safeSourceFieldsValid(
      event.safeSourceBasename,
      event.safeLineBucket
    )
  ) return false;
  if (
    (event.failureDuringCleanup &&
      event.failurePhase !== PHYSICAL_CLEANUP_PHASE) ||
    (!event.failureDuringCleanup &&
      event.failurePhase === PHYSICAL_CLEANUP_PHASE) ||
    (event.failurePhase === "exact_0004_plan_apply" &&
      event.exact0004FailureSubphase === "not_reached") ||
    (event.failurePhase !== "exact_0004_plan_apply" &&
      event.exact0004FailureSubphase !== "not_reached")
  ) return false;
  if (
    !PHYSICAL_BOUNDARY_FAILURE_STAGE_SET.has(event.firstFailureStage) &&
    (event.failureDuringCleanup || event.failurePhase !== null)
  ) return false;

  if (event.stderrCategory !== "permission_denied") {
    return event.safePermissionOrigin === "unknown" &&
      event.safeSourceBasename === null &&
      event.safeLineBucket === "unknown";
  }
  if (
    event.firstFailureStage === "test_execution" &&
    event.failurePhase === null
  ) return false;
  if (
    event.safeErrorCode !== null &&
    !SAFE_PERMISSION_CODE_SET.has(event.safeErrorCode)
  ) return false;
  if (event.safeErrorCode === "42501") {
    return event.safePermissionOrigin === "postgres_sqlstate";
  }
  if (
    event.safeErrorCode === "EACCES" ||
    event.safeErrorCode === "EPERM"
  ) {
    return ["os_filesystem", "os_process", "unknown"]
      .includes(event.safePermissionOrigin);
  }
  return event.safePermissionOrigin === "unknown";
}

function validateSafeEvent(event) {
  if (
    !event ||
    event.evidenceSchemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.event !== "string"
  ) return false;
  const markerFields = new Map([
    ["runnerReached", "runnerReached"],
    ["gateValidated", "gateValidated"],
    ["nodeTestSpawnAttempted", "nodeTestSpawnAttempted"],
    ["nodeTestProcessCreated", "nodeTestProcessCreated"],
    ["tapStarted", "tapStarted"],
    ["tapTitleObserved", "tapTitleObserved"],
    ["firstTestDiscovered", "firstTestDiscovered"]
  ]);
  if (markerFields.has(event.event)) {
    const field = markerFields.get(event.event);
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "sequence",
      field
    ]) && event[field] === true;
  }
  if (
    event.event === "mainPhaseStarted" ||
    event.event === "mainPhaseCompleted"
  ) {
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "phase",
      "sequence"
    ]) && PHYSICAL_MAIN_PHASE_SET.has(event.phase);
  }
  if (
    event.event === "exact0004SubphaseStarted" ||
    event.event === "exact0004SubphaseCompleted"
  ) {
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "operationClass",
      "sequence",
      "subphase"
    ]) &&
      EXACT_0004_EXECUTION_SUBPHASES.includes(event.subphase) &&
      event.operationClass === exact0004OperationClass(event.subphase);
  }
  if (event.event === "exact0004DatabaseMutationAttempted") {
    return exactKeys(event, [
      "databaseMutationAttempted",
      "event",
      "evidenceSchemaVersion",
      "sequence"
    ]) && event.databaseMutationAttempted === true;
  }
  if (event.event === "exact0004ConflictingNegativeAttempted") {
    return exactKeys(event, [
      "conflictingNegativeAttempted",
      "event",
      "evidenceSchemaVersion",
      "sequence"
    ]) && event.conflictingNegativeAttempted === true;
  }
  if (event.event === "exact0004ConflictingNegativePromiseSettled") {
    return exactKeys(event, [
      "conflictingNegativeFulfilledResultClass",
      "conflictingNegativeObservedSqlState",
      "conflictingNegativePromiseOutcome",
      "conflictingNegativeRejectedBeforeAssertion",
      "event",
      "evidenceSchemaVersion",
      "sequence"
    ]) && [
      "fulfilled",
      "rejected"
    ].includes(event.conflictingNegativePromiseOutcome) &&
      conflictingNegativeEvidenceValid({
        conflictingNegativeAttempted: true,
        conflictingNegativePromiseOutcome:
          event.conflictingNegativePromiseOutcome,
        conflictingNegativeObservedSqlState:
          event.conflictingNegativeObservedSqlState,
        conflictingNegativeFulfilledResultClass:
          event.conflictingNegativeFulfilledResultClass,
        conflictingNegativeAssertionMatched: null,
        conflictingNegativeRejectedBeforeAssertion:
          event.conflictingNegativeRejectedBeforeAssertion
      });
  }
  if (event.event === "exact0004ConflictingNegativeAssertionMatched") {
    return exactKeys(event, [
      "conflictingNegativeAssertionMatched",
      "event",
      "evidenceSchemaVersion",
      "sequence"
    ]) && typeof event.conflictingNegativeAssertionMatched === "boolean";
  }
  if (
    event.event === "cleanupStarted" ||
    event.event === "cleanupCompleted"
  ) {
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "phase",
      "sequence"
    ]) && event.phase === PHYSICAL_CLEANUP_PHASE;
  }
  if (event.event === "physicalPhaseSnapshot") {
    return physicalSnapshotValid(event);
  }
  if (event.event === "nodeTestClosed") {
    const exitObserved = Number.isSafeInteger(event.nodeTestExitCode) &&
      event.nodeTestExitCode >= 0 && event.nodeTestSignal === null &&
      event.nodeTestTimedOut === false;
    const signalObserved = event.nodeTestExitCode === null &&
      typeof event.nodeTestSignal === "string" &&
      SAFE_SIGNALS.has(event.nodeTestSignal) &&
      event.nodeTestTimedOut === null;
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "nodeTestExitCode",
      "nodeTestSignal",
      "nodeTestTimedOut",
      "sequence"
    ]) && (exitObserved || signalObserved);
  }
  if (event.event === "failure") {
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "failureDuringCleanup",
      "failurePhase",
      "firstFailureStage",
      "safeErrorCode",
      "safeLineBucket",
      "safeModuleName",
      "safePermissionOrigin",
      "safeSourceBasename",
      "sequence",
      "stderrCategory",
      ...EXACT_0004_EVIDENCE_FIELDS
    ]) &&
      FIRST_FAILURE_STAGE_SET.has(event.firstFailureStage) &&
      STDERR_CATEGORY_SET.has(event.stderrCategory) &&
      (event.safeErrorCode === null ||
        SAFE_ERROR_CODE_SET.has(event.safeErrorCode)) &&
      (event.safeModuleName === null ||
        SAFE_MODULE_NAME_SET.has(event.safeModuleName)) &&
      (event.safeModuleName === null ||
        event.stderrCategory === "module_not_found") &&
      failureFieldsValid(event);
  }
  return false;
}

function safeEventLine(event) {
  if (!validateSafeEvent(event)) throw new Error("safe_event_invalid");
  return SAFE_EVENT_PREFIX + canonicalJson(event) + "\n";
}

function sanitizedModuleName(candidate) {
  if (typeof candidate !== "string") return null;
  const normalized = candidate.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(basename)) return null;
  return SAFE_MODULE_NAME_SET.has(basename) ? basename : null;
}

function sanitizedSourceBasename(candidate) {
  if (typeof candidate !== "string") return null;
  const normalized = candidate.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  return SAFE_SOURCE_BASENAME_SET.has(basename) ? basename : null;
}

function safeLineBucket(lineNumber) {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > 4499) {
    return "unknown";
  }
  if (lineNumber < 500) return "1-499";
  const start = Math.floor(lineNumber / 500) * 500;
  return `${start}-${start + 499}`;
}

function safeSourceFromLine(line) {
  const match = /^\s*at(?:\s+.*?)?\s+\(?(?:file:\/\/\/)?(.+):(\d+):(\d+)\)?\s*$/.exec(
    String(line || "")
  );
  if (!match) return null;
  const safeSourceBasename = sanitizedSourceBasename(match[1]);
  if (safeSourceBasename === null) return null;
  const lineNumber = Number(match[2]);
  return Object.freeze({
    safeSourceBasename,
    safeLineBucket: safeLineBucket(lineNumber)
  });
}

function safeCodeFromLine(line) {
  for (const code of SAFE_ERROR_CODES) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`).test(line)) {
      return code;
    }
  }
  return null;
}

function safeSqlStatesFromLine(line) {
  const value = String(line || "");
  const states = [];
  for (const sqlState of SAFE_SQL_STATES) {
    const escaped = sqlState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(
      `(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`
    ).test(value)) states.push(sqlState);
  }
  return Object.freeze(states);
}

function safeErrorClassFromLine(line) {
  const value = String(line || "");
  if (/\b(?:AssertionError|ERR_ASSERTION)\b/.test(value)) {
    return "assertion_failure";
  }
  if (safeSqlStatesFromLine(value).length > 0) return "postgres_sqlstate";
  if (/\b(?:environment_contract|guard_failed)\b/.test(value)) {
    return "environment_contract";
  }
  if (/\b(?:test_timeout|ETIMEDOUT|timed out|timeout)\b/i.test(value)) {
    return "timeout";
  }
  if (/\b(?:ERR_CHILD_PROCESS|process_failure|spawn|process failed)\b/i.test(value)) {
    return "process_failure";
  }
  if (/\b(?:unexpected_result|unexpected result)\b/i.test(value)) {
    return "unexpected_result";
  }
  return "unknown";
}

function safeModuleFromLine(line) {
  const match = /(?:Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND)[^'"\r\n]*['"]([^'"\r\n]+)['"]/.exec(line);
  return match ? sanitizedModuleName(match[1]) : null;
}

function permissionCodesFromLine(line) {
  const value = String(line || "");
  const structured = /^\s*(?:(?:code|sqlstate)\s*[:=]\s*)?['"]?(42501|EACCES|EPERM)['"]?\s*,?\s*$/i.exec(
    value
  );
  if (
    !structured &&
    !/permission denied/i.test(value) &&
    !/\b(?:EACCES|EPERM)\b/i.test(value)
  ) {
    return Object.freeze([]);
  }
  const codes = new Set();
  for (const match of value.matchAll(/\b(42501|EACCES|EPERM)\b/gi)) {
    codes.add(match[1].toUpperCase());
  }
  return Object.freeze([...codes]);
}

function permissionOriginFromSyscall(candidate) {
  if (typeof candidate !== "string") return null;
  const syscall = candidate.trim().split(/\s+/, 1)[0].toLowerCase();
  if (FILESYSTEM_SYSCALL_SET.has(syscall)) return "os_filesystem";
  if (PROCESS_SYSCALL_SET.has(syscall)) return "os_process";
  return null;
}

function permissionOriginFromLine(line) {
  const match = /^\s*(?:#\s*)?syscall\s*:\s*['"]?([A-Za-z][A-Za-z0-9_]*)/i.exec(
    String(line || "")
  );
  return match ? permissionOriginFromSyscall(match[1]) : null;
}

function classifySafeLine(line) {
  const value = String(line || "");
  let stderrCategory = "unknown";
  if (/Missing script:\s*["']test:postgres-real["']/.test(value)) {
    stderrCategory = "npm_script_missing";
  } else if (/\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|Cannot find (?:module|package)/.test(value)) {
    stderrCategory = "module_not_found";
  } else if (/(?:^|\s)SyntaxError:/.test(value)) {
    stderrCategory = "syntax_error";
  } else if (/(?:^|\s)ReferenceError:/.test(value)) {
    stderrCategory = "reference_error";
  } else if (/(?:^|\s)TypeError:/.test(value)) {
    stderrCategory = "type_error";
  } else if (/\b(?:42501|EACCES|EPERM)\b|permission denied/i.test(value)) {
    stderrCategory = "permission_denied";
  } else if (/\bECONNREFUSED\b|connection refused/i.test(value)) {
    stderrCategory = "connection_refused";
  } else if (/\bERR_TLS_CERT_ALTNAME_INVALID\b|TLS[^\r\n]{0,80}hostname|hostname[^\r\n]{0,80}TLS/i.test(value)) {
    stderrCategory = "tls_hostname";
  } else if (/\b28P01\b|password authentication failed/i.test(value)) {
    stderrCategory = "postgres_authentication";
  } else if (/\b(?:3F000|42P01|42703)\b|(?:schema|relation)[^\r\n]{0,80}does not exist/i.test(value)) {
    stderrCategory = "postgres_schema";
  }
  return Object.freeze({
    stderrCategory,
    safeErrorCode: safeCodeFromLine(value),
    safeModuleName:
      stderrCategory === "module_not_found" ? safeModuleFromLine(value) : null
  });
}

function createSafeDiagnosticAggregator() {
  let stderrCategory = null;
  let safeErrorCode = null;
  let safeModuleName = null;
  let safeSource = null;
  let safeErrorClass = null;
  let invalid = false;
  let finished = false;
  const permissionCodes = new Set();
  const permissionOrigins = new Set();
  const safeSqlStates = new Set();

  function observe(line) {
    if (finished) {
      invalid = true;
      return;
    }
    const value = String(line || "");
    const candidate = classifySafeLine(value);
    for (const sqlState of safeSqlStatesFromLine(value)) {
      safeSqlStates.add(sqlState);
    }
    const errorClass = safeErrorClassFromLine(value);
    if (safeErrorClass === null && errorClass !== "unknown") {
      safeErrorClass = errorClass;
    }
    if (stderrCategory === null && candidate.stderrCategory !== "unknown") {
      stderrCategory = candidate.stderrCategory;
      if (stderrCategory !== "permission_denied") {
        safeErrorCode = candidate.safeErrorCode;
        safeModuleName = candidate.safeModuleName;
      }
    }
    if (stderrCategory !== "permission_denied") return;

    if (safeSource === null) {
      const sourceCandidate = safeSourceFromLine(value);
      if (sourceCandidate !== null) safeSource = sourceCandidate;
    }
    for (const code of permissionCodesFromLine(value)) {
      permissionCodes.add(code);
    }
    const origin = permissionOriginFromLine(value);
    if (origin !== null) permissionOrigins.add(origin);
  }

  function observeError(error) {
    observe([error?.name, error?.code, error?.message]
      .filter(Boolean).join(" "));
    const nested = [error?.actual, error?.cause];
    for (const candidate of nested) {
      if (!candidate || typeof candidate !== "object") continue;
      observe([candidate.name, candidate.code].filter(Boolean).join(" "));
    }
    if (stderrCategory !== "permission_denied") return;
    if (typeof error?.code === "string" &&
        SAFE_PERMISSION_CODE_SET.has(error.code.toUpperCase())) {
      permissionCodes.add(error.code.toUpperCase());
    }
    const origin = permissionOriginFromSyscall(error?.syscall);
    if (origin !== null) permissionOrigins.add(origin);
    if (typeof error?.stack === "string") {
      for (const line of error.stack.split(/\r?\n/)) {
        if (safeSource === null) {
          const sourceCandidate = safeSourceFromLine(line);
          if (sourceCandidate !== null) safeSource = sourceCandidate;
        }
      }
    }
  }

  function finish() {
    finished = true;
    if (stderrCategory === null) stderrCategory = "unknown";
    let safePermissionOrigin = "unknown";
    let safeSqlState = "not_observed";
    if (safeSqlStates.size > 1) invalid = true;
    else if (safeSqlStates.size === 1) [safeSqlState] = safeSqlStates;
    if (stderrCategory === "permission_denied") {
      if (permissionCodes.size > 1 || permissionOrigins.size > 1) {
        invalid = true;
      } else if (permissionCodes.size === 1) {
        [safeErrorCode] = permissionCodes;
        if (safeErrorCode === "42501") {
          if (permissionOrigins.size !== 0) invalid = true;
          else safePermissionOrigin = "postgres_sqlstate";
        } else if (permissionOrigins.size === 1) {
          [safePermissionOrigin] = permissionOrigins;
        }
      }
      if (invalid) {
        safeErrorCode = null;
        safePermissionOrigin = "unknown";
      }
      safeModuleName = null;
    }
    if (invalid) {
      safeSqlState = "unknown";
      safeErrorClass = "unknown";
    } else if (
      SAFE_SQL_STATE_SET.has(safeSqlState) &&
      (safeErrorClass === null || safeErrorClass === "unknown")
    ) {
      safeErrorClass = "postgres_sqlstate";
    }
    return Object.freeze({
      safeDiagnosticValid: !invalid,
      stderrCategory,
      safeErrorCode,
      safeModuleName,
      safeSqlState,
      safeErrorClass: safeErrorClass || "unknown",
      safePermissionOrigin,
      safeSourceBasename:
        stderrCategory === "permission_denied"
          ? safeSource?.safeSourceBasename || null
          : null,
      safeLineBucket:
        stderrCategory === "permission_denied"
          ? safeSource?.safeLineBucket || "unknown"
          : "unknown"
    });
  }

  return Object.freeze({ observe, observeError, finish });
}

function createLineFramer(onLine) {
  const states = {
    stdout: { decoder: new StringDecoder("utf8"), carry: "" },
    stderr: { decoder: new StringDecoder("utf8"), carry: "" }
  };
  let bytes = 0;
  let overflow = false;
  function push(channel, chunk) {
    if (!Object.prototype.hasOwnProperty.call(states, channel)) {
      overflow = true;
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > SAFE_OUTPUT_LIMIT) overflow = true;
    const state = states[channel];
    const joined = state.carry + state.decoder.write(buffer);
    const parts = joined.split("\n");
    state.carry = parts.pop();
    if (Buffer.byteLength(state.carry, "utf8") > SAFE_LINE_LIMIT) {
      overflow = true;
      state.carry = "";
    }
    for (const item of parts) {
      if (Buffer.byteLength(item, "utf8") > SAFE_LINE_LIMIT) overflow = true;
      else onLine(channel, item.endsWith("\r") ? item.slice(0, -1) : item);
    }
  }
  function finish() {
    for (const [channel, state] of Object.entries(states)) {
      const tail = state.carry + state.decoder.end();
      if (tail) {
        if (Buffer.byteLength(tail, "utf8") > SAFE_LINE_LIMIT) overflow = true;
        else onLine(channel, tail.endsWith("\r") ? tail.slice(0, -1) : tail);
      }
      state.carry = "";
    }
    return Object.freeze({ bytes, overflow });
  }
  return Object.freeze({ push, finish });
}

function createPhysicalPhaseProtocol() {
  let expectedSequence = 1;
  let nextMainPhaseIndex = 0;
  let activeMainPhase = null;
  let lastMainPhaseStarted = null;
  let lastMainPhaseCompleted = null;
  let nextExact0004SubphaseIndex = 0;
  let activeExact0004Subphase = null;
  let lastExact0004SubphaseStarted = "not_reached";
  let lastExact0004SubphaseCompleted = "not_reached";
  let planExactInvoked = false;
  let planExactCompleted = false;
  let applyExactInvoked = false;
  let applyExactCompleted = false;
  let databaseMutationAttempted = false;
  let conflictingNegativeAttempted = false;
  let conflictingNegativePromiseOutcome = "not_started";
  let conflictingNegativeObservedSqlState = "not_observed";
  let conflictingNegativeFulfilledResultClass = "not_observed";
  let conflictingNegativeAssertionMatched = null;
  let conflictingNegativeRejectedBeforeAssertion = null;
  let cleanupStarted = false;
  let cleanupCompleted = false;
  let protocolInvalid = false;
  let finished = false;

  function invalidate() {
    protocolInvalid = true;
  }

  function accept(event) {
    if (
      finished ||
      protocolInvalid ||
      !validateSafeEvent(event) ||
      event.sequence !== expectedSequence
    ) {
      invalidate();
      return false;
    }
    if (event.event === "exact0004SubphaseStarted") {
      if (
        cleanupStarted ||
        activeMainPhase !== "exact_0004_plan_apply" ||
        activeExact0004Subphase !== null ||
        event.subphase !==
          EXACT_0004_EXECUTION_SUBPHASES[nextExact0004SubphaseIndex]
      ) {
        invalidate();
        return false;
      }
      activeExact0004Subphase = event.subphase;
      lastExact0004SubphaseStarted = event.subphase;
      if (event.subphase === "plan_exact") planExactInvoked = true;
      if (event.subphase === "apply_exact") applyExactInvoked = true;
    } else if (event.event === "exact0004SubphaseCompleted") {
      if (
        cleanupStarted ||
        activeMainPhase !== "exact_0004_plan_apply" ||
        activeExact0004Subphase !== event.subphase ||
        event.subphase !==
          EXACT_0004_EXECUTION_SUBPHASES[nextExact0004SubphaseIndex]
      ) {
        invalidate();
        return false;
      }
      if (
        event.subphase === "conflicting_0004_negative" &&
        !conflictingNegativeSucceeded({
          conflictingNegativeAttempted,
          conflictingNegativePromiseOutcome,
          conflictingNegativeObservedSqlState,
          conflictingNegativeFulfilledResultClass,
          conflictingNegativeAssertionMatched,
          conflictingNegativeRejectedBeforeAssertion
        })
      ) {
        invalidate();
        return false;
      }
      activeExact0004Subphase = null;
      lastExact0004SubphaseCompleted = event.subphase;
      nextExact0004SubphaseIndex += 1;
      if (event.subphase === "plan_exact") planExactCompleted = true;
      if (event.subphase === "apply_exact") applyExactCompleted = true;
    } else if (event.event === "exact0004DatabaseMutationAttempted") {
      if (
        cleanupStarted ||
        activeMainPhase !== "exact_0004_plan_apply" ||
        activeExact0004Subphase !== "conflicting_0004_negative" ||
        databaseMutationAttempted
      ) {
        invalidate();
        return false;
      }
      databaseMutationAttempted = true;
    } else if (event.event === "exact0004ConflictingNegativeAttempted") {
      if (
        cleanupStarted ||
        activeMainPhase !== "exact_0004_plan_apply" ||
        activeExact0004Subphase !== "conflicting_0004_negative" ||
        !databaseMutationAttempted ||
        conflictingNegativeAttempted
      ) {
        invalidate();
        return false;
      }
      conflictingNegativeAttempted = true;
    } else if (
      event.event === "exact0004ConflictingNegativePromiseSettled"
    ) {
      if (
        cleanupStarted ||
        activeMainPhase !== "exact_0004_plan_apply" ||
        activeExact0004Subphase !== "conflicting_0004_negative" ||
        !conflictingNegativeAttempted ||
        conflictingNegativePromiseOutcome !== "not_started"
      ) {
        invalidate();
        return false;
      }
      conflictingNegativePromiseOutcome =
        event.conflictingNegativePromiseOutcome;
      conflictingNegativeObservedSqlState =
        event.conflictingNegativeObservedSqlState;
      conflictingNegativeFulfilledResultClass =
        event.conflictingNegativeFulfilledResultClass;
      conflictingNegativeRejectedBeforeAssertion =
        event.conflictingNegativeRejectedBeforeAssertion;
    } else if (
      event.event === "exact0004ConflictingNegativeAssertionMatched"
    ) {
      if (
        cleanupStarted ||
        activeMainPhase !== "exact_0004_plan_apply" ||
        activeExact0004Subphase !== "conflicting_0004_negative" ||
        conflictingNegativePromiseOutcome !== "rejected" ||
        conflictingNegativeRejectedBeforeAssertion !== true ||
        conflictingNegativeAssertionMatched !== null ||
        event.conflictingNegativeAssertionMatched !==
          (conflictingNegativeObservedSqlState === "23514")
      ) {
        invalidate();
        return false;
      }
      conflictingNegativeAssertionMatched =
        event.conflictingNegativeAssertionMatched;
    } else if (event.event === "mainPhaseStarted") {
      if (
        cleanupStarted ||
        activeMainPhase !== null ||
        event.phase !== PHYSICAL_MAIN_PHASES[nextMainPhaseIndex]
      ) {
        invalidate();
        return false;
      }
      activeMainPhase = event.phase;
      lastMainPhaseStarted = event.phase;
    } else if (event.event === "mainPhaseCompleted") {
      if (
        cleanupStarted ||
        activeMainPhase !== event.phase ||
        event.phase !== PHYSICAL_MAIN_PHASES[nextMainPhaseIndex]
      ) {
        invalidate();
        return false;
      }
      if (event.phase === "exact_0004_plan_apply") {
        if (
          activeExact0004Subphase !== null ||
          nextExact0004SubphaseIndex !==
            EXACT_0004_EXECUTION_SUBPHASES.length ||
          !planExactCompleted ||
          !applyExactCompleted ||
          !databaseMutationAttempted
        ) {
          invalidate();
          return false;
        }
      }
      activeMainPhase = null;
      lastMainPhaseCompleted = event.phase;
      nextMainPhaseIndex += 1;
    } else if (event.event === "cleanupStarted") {
      if (
        cleanupStarted ||
        cleanupCompleted ||
        !(
          activeMainPhase !== null ||
          nextMainPhaseIndex === PHYSICAL_MAIN_PHASES.length
        )
      ) {
        invalidate();
        return false;
      }
      cleanupStarted = true;
    } else if (event.event === "cleanupCompleted") {
      if (!cleanupStarted || cleanupCompleted) {
        invalidate();
        return false;
      }
      cleanupCompleted = true;
    } else {
      invalidate();
      return false;
    }
    expectedSequence += 1;
    return true;
  }

  function finish() {
    finished = true;
    const exact0004Active = activeMainPhase === "exact_0004_plan_apply";
    const exact0004FailureSubphase = exact0004Active
      ? activeExact0004Subphase || "unknown"
      : "not_reached";
    const conflictingNegativeOutcomeUnobserved =
      conflictingNegativeAttempted &&
      conflictingNegativePromiseOutcome === "not_started";
    return Object.freeze({
      protocolValid: !protocolInvalid,
      eventCount: expectedSequence - 1,
      lastMainPhaseStarted,
      lastMainPhaseCompleted,
      lastExact0004SubphaseStarted,
      lastExact0004SubphaseCompleted,
      exact0004FailureSubphase,
      safeSqlState: exact0004Active ? "unknown" : "not_observed",
      safeErrorClass: "unknown",
      safeOperationClass:
        exact0004OperationClass(exact0004FailureSubphase),
      planExactInvoked,
      planExactCompleted,
      applyExactInvoked,
      applyExactCompleted,
      databaseMutationAttempted,
      failureBeforeFirstMutation:
        exact0004Active && !databaseMutationAttempted,
      conflictingNegativeAttempted,
      conflictingNegativePromiseOutcome:
        conflictingNegativeOutcomeUnobserved
          ? "unknown"
          : conflictingNegativePromiseOutcome,
      conflictingNegativeObservedSqlState:
        conflictingNegativeOutcomeUnobserved
          ? "unknown"
          : conflictingNegativeObservedSqlState,
      conflictingNegativeFulfilledResultClass:
        conflictingNegativeOutcomeUnobserved
          ? "unknown"
          : conflictingNegativeFulfilledResultClass,
      conflictingNegativeAssertionMatched,
      conflictingNegativeRejectedBeforeAssertion,
      cleanupStarted,
      cleanupCompleted
    });
  }

  return Object.freeze({ accept, finish, invalidate });
}

function createPhysicalPhaseEmitter(
  writeLine = (line) => process.stderr.write(line)
) {
  if (typeof writeLine !== "function") {
    throw new TypeError("physical_phase_writer_invalid");
  }
  const protocol = createPhysicalPhaseProtocol();
  let sequence = 0;

  function emit(event, fields) {
    sequence += 1;
    const value = {
      event,
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      sequence,
      ...fields
    };
    if (!protocol.accept(value)) {
      throw new Error("physical_phase_protocol_invalid");
    }
    writeLine(safeEventLine(value));
  }

  return Object.freeze({
    startMain: (phase) => emit("mainPhaseStarted", { phase }),
    completeMain: (phase) => emit("mainPhaseCompleted", { phase }),
    startExact0004Subphase: (subphase) =>
      emit("exact0004SubphaseStarted", {
        operationClass: exact0004OperationClass(subphase),
        subphase
      }),
    completeExact0004Subphase: (subphase) =>
      emit("exact0004SubphaseCompleted", {
        operationClass: exact0004OperationClass(subphase),
        subphase
      }),
    markExact0004DatabaseMutationAttempted: () =>
      emit("exact0004DatabaseMutationAttempted", {
        databaseMutationAttempted: true
      }),
    markExact0004ConflictingNegativeAttempted: () =>
      emit("exact0004ConflictingNegativeAttempted", {
        conflictingNegativeAttempted: true
      }),
    observeExact0004ConflictingNegative: (promise) =>
      Promise.resolve(promise).then(
        (value) => {
          emit("exact0004ConflictingNegativePromiseSettled", {
            conflictingNegativePromiseOutcome: "fulfilled",
            conflictingNegativeObservedSqlState: "not_observed",
            conflictingNegativeFulfilledResultClass:
              conflictingNegativeFulfilledResultClass(value),
            conflictingNegativeRejectedBeforeAssertion: false
          });
          return value;
        },
        (error) => {
          emit("exact0004ConflictingNegativePromiseSettled", {
            conflictingNegativePromiseOutcome: "rejected",
            conflictingNegativeObservedSqlState:
              sanitizedPostgresSqlState(error),
            conflictingNegativeFulfilledResultClass: "not_observed",
            conflictingNegativeRejectedBeforeAssertion: true
          });
          throw error;
        }
      ),
    markExact0004ConflictingNegativeAssertionMatched: (matched) =>
      emit("exact0004ConflictingNegativeAssertionMatched", {
        conflictingNegativeAssertionMatched: matched
      }),
    startCleanup: () => emit("cleanupStarted", {
      phase: PHYSICAL_CLEANUP_PHASE
    }),
    completeCleanup: () => emit("cleanupCompleted", {
      phase: PHYSICAL_CLEANUP_PHASE
    })
  });
}

function childSafeEventBody(line) {
  const prefixes = [
    SAFE_EVENT_PREFIX,
    `# ${SAFE_EVENT_PREFIX}`,
    `    # ${SAFE_EVENT_PREFIX}`
  ];
  for (const prefix of prefixes) {
    if (line.startsWith(prefix)) {
      return Object.freeze({ matched: true, body: line.slice(prefix.length) });
    }
  }
  return Object.freeze({
    matched: line.includes(SAFE_EVENT_PREFIX),
    body: null
  });
}

function createNodeTestObserver(onMarker = () => {}) {
  const totals = { tests: [], pass: [], fail: [], skipped: [], cancelled: [] };
  const markers = {
    tapStarted: false,
    tapTitleObserved: false,
    firstTestDiscovered: false
  };
  const diagnostic = createSafeDiagnosticAggregator();
  const physicalPhases = createPhysicalPhaseProtocol();
  function mark(name) {
    if (markers[name]) return;
    markers[name] = true;
    onMarker(name);
  }
  const framer = createLineFramer((channel, line) => {
    const safeChildEvent = childSafeEventBody(line);
    if (safeChildEvent.matched) {
      if (safeChildEvent.body === null) {
        physicalPhases.invalidate();
        return;
      }
      let event;
      try {
        event = JSON.parse(safeChildEvent.body);
      } catch {
        physicalPhases.invalidate();
        return;
      }
      if (
        canonicalJson(event) !== safeChildEvent.body ||
        !physicalPhases.accept(event)
      ) physicalPhases.invalidate();
      return;
    }
    if (channel === "stdout") {
      if (line === "TAP version 13") mark("tapStarted");
      if (line === TAP_SUBTEST_TITLE) mark("tapTitleObserved");
      if (line.startsWith("# Subtest: ")) mark("firstTestDiscovered");
      const total = /^(?:#|\u2139)\s*(tests|pass|fail|skipped|cancelled)\s+([0-9]+)\s*$/.exec(line);
      if (total) totals[total[1]].push(Number(total[2]));
    }
    diagnostic.observe(line);
  });
  function finish() {
    const framed = framer.finish();
    const physicalPhaseFacts = physicalPhases.finish();
    const one = (name) => totals[name].length === 1 ? totals[name][0] : null;
    const tapFail = one("fail");
    const diagnosticFacts = diagnostic.finish();
    const stderrCategory =
      diagnosticFacts.stderrCategory === "unknown" &&
      tapFail !== null && tapFail > 0
        ? "tap_failure"
        : diagnosticFacts.stderrCategory;
    const exact0004FailureObserved =
      physicalPhaseFacts.exact0004FailureSubphase !== "not_reached";
    const safeSqlState = exact0004FailureObserved
      ? diagnosticFacts.safeSqlState === "not_observed"
        ? "unknown"
        : diagnosticFacts.safeSqlState
      : "not_observed";
    return Object.freeze({
      overflow: framed.overflow,
      tapStarted: markers.tapStarted,
      tapTitleObserved: markers.tapTitleObserved,
      firstTestDiscovered: markers.firstTestDiscovered,
      tapTests: one("tests"),
      tapPass: one("pass"),
      tapFail,
      tapSkipped: one("skipped"),
      tapCancelled: one("cancelled"),
      phaseProtocolValid: physicalPhaseFacts.protocolValid,
      phaseEventCount: physicalPhaseFacts.eventCount,
      lastMainPhaseStarted: physicalPhaseFacts.lastMainPhaseStarted,
      lastMainPhaseCompleted: physicalPhaseFacts.lastMainPhaseCompleted,
      lastExact0004SubphaseStarted:
        physicalPhaseFacts.lastExact0004SubphaseStarted,
      lastExact0004SubphaseCompleted:
        physicalPhaseFacts.lastExact0004SubphaseCompleted,
      exact0004FailureSubphase:
        physicalPhaseFacts.exact0004FailureSubphase,
      safeSqlState,
      safeErrorClass: exact0004FailureObserved
        ? diagnosticFacts.safeErrorClass
        : "unknown",
      safeOperationClass: physicalPhaseFacts.safeOperationClass,
      planExactInvoked: physicalPhaseFacts.planExactInvoked,
      planExactCompleted: physicalPhaseFacts.planExactCompleted,
      applyExactInvoked: physicalPhaseFacts.applyExactInvoked,
      applyExactCompleted: physicalPhaseFacts.applyExactCompleted,
      databaseMutationAttempted:
        physicalPhaseFacts.databaseMutationAttempted,
      failureBeforeFirstMutation:
        physicalPhaseFacts.failureBeforeFirstMutation,
      conflictingNegativeAttempted:
        physicalPhaseFacts.conflictingNegativeAttempted,
      conflictingNegativePromiseOutcome:
        physicalPhaseFacts.conflictingNegativePromiseOutcome,
      conflictingNegativeObservedSqlState:
        physicalPhaseFacts.conflictingNegativeObservedSqlState,
      conflictingNegativeFulfilledResultClass:
        physicalPhaseFacts.conflictingNegativeFulfilledResultClass,
      conflictingNegativeAssertionMatched:
        physicalPhaseFacts.conflictingNegativeAssertionMatched,
      conflictingNegativeRejectedBeforeAssertion:
        physicalPhaseFacts.conflictingNegativeRejectedBeforeAssertion,
      cleanupStarted: physicalPhaseFacts.cleanupStarted,
      cleanupCompleted: physicalPhaseFacts.cleanupCompleted,
      safeDiagnosticValid: diagnosticFacts.safeDiagnosticValid,
      stderrCategory,
      safeErrorCode: diagnosticFacts.safeErrorCode,
      safeModuleName: diagnosticFacts.safeModuleName,
      safePermissionOrigin: diagnosticFacts.safePermissionOrigin,
      safeSourceBasename: diagnosticFacts.safeSourceBasename,
      safeLineBucket: diagnosticFacts.safeLineBucket
    });
  }
  return Object.freeze({ push: framer.push, finish });
}

function createSafeEventCollector(options = {}) {
  const onAcceptedEvent = typeof options.onAcceptedEvent === "function"
    ? options.onAcceptedEvent
    : () => {};
  const seen = new Set();
  const state = {
    runnerReached: null,
    gateValidated: null,
    nodeTestSpawnAttempted: null,
    nodeTestProcessCreated: null,
    nodeTestExitCode: null,
    nodeTestSignal: null,
    nodeTestTimedOut: null,
    tapStarted: null,
    tapTitleObserved: null,
    firstTestDiscovered: null,
    lastMainPhaseStarted: null,
    lastMainPhaseCompleted: null,
    ...emptyExact0004Evidence(),
    cleanupStarted: null,
    cleanupCompleted: null,
    failureDuringCleanup: null,
    failurePhase: null,
    stderrCategory: null,
    safeErrorCode: null,
    safeModuleName: null,
    safePermissionOrigin: null,
    safeSourceBasename: null,
    safeLineBucket: null,
    firstFailureStage: null
  };
  let expectedSequence = 1;
  let protocolInvalid = false;
  let closed = false;
  let failure = false;
  const rawDiagnostic = createSafeDiagnosticAggregator();
  function invalidate() {
    protocolInvalid = true;
  }
  function notifyAcceptedEvent(name) {
    try {
      onAcceptedEvent(name, Object.freeze({ ...state }));
    } catch {
      // The observer is deliberately non-authoritative. Its durable transport
      // is validated independently by the workflow finalizer.
    }
  }
  function markerAllowed(name) {
    if (failure || closed || seen.has(name)) return false;
    if (name === "runnerReached") return seen.size === 0;
    if (name === "gateValidated") return state.runnerReached === true;
    if (name === "nodeTestSpawnAttempted") return state.gateValidated === true;
    if (name === "nodeTestProcessCreated") {
      return state.nodeTestSpawnAttempted === true;
    }
    if (name === "tapStarted") return state.nodeTestProcessCreated === true;
    if (name === "tapTitleObserved" || name === "firstTestDiscovered") {
      return state.tapStarted === true;
    }
    if (name === "physicalPhaseSnapshot") {
      return state.nodeTestProcessCreated === true;
    }
    return false;
  }
  function nullFailureBoundary(event) {
    return event.failureDuringCleanup === false &&
      event.failurePhase === null;
  }
  function snapshotFailureBoundary() {
    const mainActive =
      PHYSICAL_MAIN_PHASE_SET.has(state.lastMainPhaseStarted) &&
      state.lastMainPhaseStarted !== state.lastMainPhaseCompleted;
    if (mainActive) {
      return Object.freeze({
        failureDuringCleanup: false,
        failurePhase: state.lastMainPhaseStarted
      });
    }
    if (state.cleanupStarted === true && state.cleanupCompleted === false) {
      return Object.freeze({
        failureDuringCleanup: true,
        failurePhase: PHYSICAL_CLEANUP_PHASE
      });
    }
    return Object.freeze({ failureDuringCleanup: false, failurePhase: null });
  }
  function failureBoundaryMatchesSnapshot(event) {
    const expected = snapshotFailureBoundary();
    return event.failureDuringCleanup === expected.failureDuringCleanup &&
      event.failurePhase === expected.failurePhase;
  }
  function failureAllowed(event) {
    if (failure || seen.has("failure") || state.runnerReached !== true) return false;
    if (seen.has("physicalPhaseSnapshot")) {
      if (EXACT_0004_EVIDENCE_FIELDS.some(
        (field) => event[field] !== state[field]
      )) return false;
    } else {
      const emptyExact0004 = emptyExact0004Evidence();
      if (EXACT_0004_EVIDENCE_FIELDS.some(
        (field) => event[field] !== emptyExact0004[field]
      )) return false;
    }
    if (event.firstFailureStage === "runner_load" ||
        event.firstFailureStage === "environment_gate") {
      return state.gateValidated !== true &&
        state.nodeTestSpawnAttempted !== true && !closed &&
        nullFailureBoundary(event);
    }
    if (event.firstFailureStage === "node_test_spawn") {
      return state.nodeTestSpawnAttempted === true &&
        state.nodeTestProcessCreated !== true && !closed &&
        nullFailureBoundary(event);
    }
    if (event.firstFailureStage === "node_test_bootstrap") {
      return state.nodeTestProcessCreated === true &&
        nullFailureBoundary(event);
    }
    if (event.firstFailureStage === "safe_event_protocol") {
      if (seen.has("physicalPhaseSnapshot")) {
        return closed && failureBoundaryMatchesSnapshot(event);
      }
      return !closed && nullFailureBoundary(event);
    }
    if (!closed) return false;
    if (event.firstFailureStage === "tap_start") {
      return state.tapStarted !== true && nullFailureBoundary(event);
    }
    if (event.firstFailureStage === "test_discovery") {
      return state.tapStarted === true &&
        state.firstTestDiscovered !== true &&
        nullFailureBoundary(event);
    }
    if (event.firstFailureStage === "test_execution") {
      return state.firstTestDiscovered === true &&
        failureBoundaryMatchesSnapshot(event);
    }
    return false;
  }
  function applyEvent(event) {
    if (
      protocolInvalid ||
      !validateSafeEvent(event) ||
      event.sequence !== expectedSequence
    ) {
      invalidate();
      return;
    }
    expectedSequence += 1;
    if ([
      "runnerReached",
      "gateValidated",
      "nodeTestSpawnAttempted",
      "nodeTestProcessCreated",
      "tapStarted",
      "tapTitleObserved",
      "firstTestDiscovered"
    ].includes(event.event)) {
      if (!markerAllowed(event.event)) {
        invalidate();
        return;
      }
      seen.add(event.event);
      state[event.event] = true;
      notifyAcceptedEvent(event.event);
      return;
    }
    if (event.event === "physicalPhaseSnapshot") {
      if (!markerAllowed(event.event)) {
        invalidate();
        return;
      }
      seen.add(event.event);
      state.lastMainPhaseStarted = event.lastMainPhaseStarted;
      state.lastMainPhaseCompleted = event.lastMainPhaseCompleted;
      for (const field of EXACT_0004_EVIDENCE_FIELDS) {
        state[field] = event[field];
      }
      state.cleanupStarted = event.cleanupStarted;
      state.cleanupCompleted = event.cleanupCompleted;
      notifyAcceptedEvent(event.event);
      return;
    }
    if (event.event === "nodeTestClosed") {
      if (
        failure ||
        closed ||
        state.nodeTestProcessCreated !== true ||
        !seen.has("physicalPhaseSnapshot") ||
        seen.has("nodeTestClosed")
      ) {
        invalidate();
        return;
      }
      closed = true;
      seen.add(event.event);
      state.nodeTestExitCode = event.nodeTestExitCode;
      state.nodeTestSignal = event.nodeTestSignal;
      state.nodeTestTimedOut = event.nodeTestTimedOut;
      notifyAcceptedEvent(event.event);
      return;
    }
    if (event.event === "failure") {
      if (!failureAllowed(event)) {
        invalidate();
        return;
      }
      failure = true;
      seen.add(event.event);
      state.stderrCategory = event.stderrCategory;
      state.safeErrorCode = event.safeErrorCode;
      state.safeModuleName = event.safeModuleName;
      state.failureDuringCleanup = event.failureDuringCleanup;
      state.failurePhase = event.failurePhase;
      state.safePermissionOrigin = event.safePermissionOrigin;
      state.safeSourceBasename = event.safeSourceBasename;
      state.safeLineBucket = event.safeLineBucket;
      state.firstFailureStage = event.firstFailureStage;
      if (!seen.has("physicalPhaseSnapshot")) {
        for (const field of EXACT_0004_EVIDENCE_FIELDS) {
          state[field] = event[field];
        }
      }
      notifyAcceptedEvent(event.event);
      return;
    }
    invalidate();
  }
  const framer = createLineFramer((channel, line) => {
    if (line.startsWith(SAFE_EVENT_PREFIX)) {
      if (channel !== "stdout") {
        invalidate();
        return;
      }
      const body = line.slice(SAFE_EVENT_PREFIX.length);
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        invalidate();
        return;
      }
      if (canonicalJson(event) !== body) {
        invalidate();
        return;
      }
      applyEvent(event);
      return;
    }
    if (channel === "stderr") rawDiagnostic.observe(line);
  });
  function finish() {
    const framed = framer.finish();
    const rawClassification = rawDiagnostic.finish();
    if (framed.overflow) invalidate();
    if (!rawClassification.safeDiagnosticValid) invalidate();
    if (protocolInvalid && !failure) {
      const boundary = seen.has("physicalPhaseSnapshot")
        ? snapshotFailureBoundary()
        : { failureDuringCleanup: false, failurePhase: null };
      state.stderrCategory = "unknown";
      state.safeErrorCode = framed.overflow
        ? "safe_output_limit_exceeded"
        : "safe_event_protocol_invalid";
      state.safeModuleName = null;
      state.failureDuringCleanup = boundary.failureDuringCleanup;
      state.failurePhase = boundary.failurePhase;
      state.safePermissionOrigin = "unknown";
      state.safeSourceBasename = null;
      state.safeLineBucket = "unknown";
      state.firstFailureStage = "safe_event_protocol";
    } else if (!failure && rawClassification.stderrCategory !== "unknown") {
      state.stderrCategory = rawClassification.stderrCategory;
      state.safeErrorCode = rawClassification.safeErrorCode;
      state.safeModuleName = rawClassification.safeModuleName;
      state.safePermissionOrigin = rawClassification.safePermissionOrigin;
      state.safeSourceBasename = rawClassification.safeSourceBasename;
      state.safeLineBucket = rawClassification.safeLineBucket;
    }
    return Object.freeze({
      protocolValid: !protocolInvalid,
      closed,
      failure,
      eventCount: expectedSequence - 1,
      ...state
    });
  }
  return Object.freeze({ push: framer.push, finish });
}

function safeFailureFromError(error, fallbackCategory = "unknown") {
  const diagnostic = createSafeDiagnosticAggregator();
  diagnostic.observeError(error);
  const classified = diagnostic.finish();
  if (!classified.safeDiagnosticValid) {
    return Object.freeze({
      firstFailureStage: "safe_event_protocol",
      stderrCategory: "unknown",
      safeErrorCode: "safe_event_protocol_invalid",
      safeModuleName: null,
      safePermissionOrigin: "unknown",
      safeSourceBasename: null,
      safeLineBucket: "unknown",
      safeSqlState: "unknown",
      safeErrorClass: "unknown"
    });
  }
  return Object.freeze({
    stderrCategory:
      classified.stderrCategory === "unknown"
        ? fallbackCategory
        : classified.stderrCategory,
    safeErrorCode: classified.safeErrorCode,
    safeModuleName: classified.safeModuleName,
    safePermissionOrigin: classified.safePermissionOrigin,
    safeSourceBasename: classified.safeSourceBasename,
    safeLineBucket: classified.safeLineBucket,
    safeSqlState: classified.safeSqlState === "not_observed"
      ? "unknown"
      : classified.safeSqlState,
    safeErrorClass: classified.safeErrorClass !== "unknown"
      ? classified.safeErrorClass
      : fallbackCategory === "environment_contract"
        ? "environment_contract"
        : "process_failure"
  });
}

function exact0004EvidenceFromFacts(facts) {
  const defaults = emptyExact0004Evidence();
  const result = {};
  for (const field of EXACT_0004_EVIDENCE_FIELDS) {
    result[field] = facts?.[field] ?? defaults[field];
  }
  if (
    result.exact0004FailureSubphase !== "not_reached" &&
    result.safeSqlState === "not_observed"
  ) {
    result.safeSqlState = "unknown";
  } else if (result.exact0004FailureSubphase === "not_reached") {
    result.safeSqlState = "not_observed";
    result.safeErrorClass = "unknown";
  }
  return Object.freeze(result);
}

function emptyFailureBoundary() {
  return Object.freeze({ failureDuringCleanup: false, failurePhase: null });
}

function physicalFailureBoundary(facts) {
  if (
    PHYSICAL_MAIN_PHASE_SET.has(facts.lastMainPhaseStarted) &&
    facts.lastMainPhaseStarted !== facts.lastMainPhaseCompleted
  ) {
    return Object.freeze({
      failureDuringCleanup: false,
      failurePhase: facts.lastMainPhaseStarted
    });
  }
  if (facts.cleanupStarted && !facts.cleanupCompleted) {
    return Object.freeze({
      failureDuringCleanup: true,
      failurePhase: PHYSICAL_CLEANUP_PHASE
    });
  }
  return emptyFailureBoundary();
}

function physicalPhaseContractValid(facts, result) {
  if (!facts.phaseProtocolValid) return false;
  if (facts.firstTestDiscovered && facts.lastMainPhaseStarted === null) {
    return false;
  }
  if (result.status !== 0 || result.signal !== null) return true;
  return facts.lastMainPhaseStarted === PHYSICAL_MAIN_PHASES.at(-1) &&
    facts.lastMainPhaseCompleted === PHYSICAL_MAIN_PHASES.at(-1) &&
    facts.cleanupStarted === true && facts.cleanupCompleted === true;
}

function nodeTestFailure(facts, result) {
  const exact0004Evidence = exact0004EvidenceFromFacts(facts);
  const exactTap = facts.tapStarted &&
    facts.tapTitleObserved &&
    facts.firstTestDiscovered &&
    facts.tapTests === 1 &&
    facts.tapPass === 1 &&
    facts.tapFail === 0 &&
    facts.tapSkipped === 0 &&
    facts.tapCancelled === 0;
  const phaseContractValid = physicalPhaseContractValid(facts, result);
  const boundary = physicalFailureBoundary(facts);
  if (result.status === 0 && result.signal === null &&
      !facts.overflow && exactTap && phaseContractValid &&
      facts.safeDiagnosticValid) return null;
  if (!phaseContractValid || !facts.safeDiagnosticValid) {
    return Object.freeze({
      ...exact0004Evidence,
      ...boundary,
      firstFailureStage: "safe_event_protocol",
      stderrCategory: "unknown",
      safeErrorCode: "safe_event_protocol_invalid",
      safeModuleName: null,
      safePermissionOrigin: "unknown",
      safeSourceBasename: null,
      safeLineBucket: "unknown"
    });
  }
  let firstFailureStage = "node_test_bootstrap";
  if (facts.firstTestDiscovered) firstFailureStage = "test_execution";
  else if (facts.tapStarted) firstFailureStage = "test_discovery";
  else if (result.status === 0) firstFailureStage = "tap_start";
  let stderrCategory = facts.stderrCategory;
  if (stderrCategory === "unknown" && facts.tapStarted) {
    stderrCategory = "tap_failure";
  }
  let safeErrorCode = facts.safeErrorCode;
  if (facts.overflow) safeErrorCode = "safe_output_limit_exceeded";
  else if (safeErrorCode === null && result.status === 0) {
    safeErrorCode = "tap_contract_failed";
  } else if (
    safeErrorCode === null &&
    result.status !== 0 &&
    stderrCategory !== "permission_denied"
  ) {
    safeErrorCode = "ERR_TEST_FAILURE";
  }
  if (
    firstFailureStage === "test_execution" &&
    stderrCategory === "permission_denied" &&
    boundary.failurePhase === null
  ) {
    return Object.freeze({
      ...exact0004Evidence,
      ...boundary,
      firstFailureStage: "safe_event_protocol",
      stderrCategory: "unknown",
      safeErrorCode: "safe_event_protocol_invalid",
      safeModuleName: null,
      safePermissionOrigin: "unknown",
      safeSourceBasename: null,
      safeLineBucket: "unknown"
    });
  }
  return Object.freeze({
    ...exact0004Evidence,
    ...(firstFailureStage === "test_execution"
      ? boundary
      : emptyFailureBoundary()),
    firstFailureStage,
    stderrCategory,
    safeErrorCode,
    safeModuleName:
      stderrCategory === "module_not_found" ? facts.safeModuleName : null,
    safePermissionOrigin:
      stderrCategory === "permission_denied"
        ? facts.safePermissionOrigin
        : "unknown",
    safeSourceBasename:
      stderrCategory === "permission_denied"
        ? facts.safeSourceBasename
        : null,
    safeLineBucket:
      stderrCategory === "permission_denied"
        ? facts.safeLineBucket
        : "unknown"
  });
}

function runNodeTest({
  configuration,
  env,
  onCreated,
  onMarker,
  spawnImpl = spawn
}) {
  return new Promise((resolve) => {
    const observer = createNodeTestObserver(onMarker);
    let child;
    try {
      child = spawnImpl(
        process.execPath,
        [
          "--test-reporter=tap",
          "--test-reporter-destination=stdout",
          "--test",
          path.resolve(__dirname, "..", "tests", "social-postgres-real.test.js")
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          env: {
            ...env,
            SOCIAL_REAL_POSTGRES_REQUIRED: "true",
            SOCIAL_TEST_GATE_VALIDATED_FINGERPRINT: configuration.fingerprint
          },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        }
      );
    } catch (error) {
      resolve(Object.freeze({
        created: false,
        error,
        status: null,
        signal: null,
        facts: null
      }));
      return;
    }
    let created = false;
    let settled = false;
    let streamError = false;
    if (child.stdout) {
      child.stdout.on("data", (chunk) => observer.push("stdout", chunk));
      child.stdout.once("error", () => { streamError = true; });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => observer.push("stderr", chunk));
      child.stderr.once("error", () => { streamError = true; });
    }
    child.once("spawn", () => {
      created = true;
      onCreated();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({
        created,
        error,
        status: null,
        signal: null,
        facts: null
      }));
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      const facts = observer.finish();
      resolve(Object.freeze({
        created,
        error: streamError ? Object.assign(new Error("stream_error"), {
          code: "test_process_failed"
        }) : null,
        status,
        signal,
        facts
      }));
    });
  });
}

class PostgresGateRefusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "PostgresGateRefusal";
  }
}

function refuse(code) {
  throw new PostgresGateRefusal(code);
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    refuse(`${name.toLowerCase()}_missing`);
  }
  return value;
}

function decodeUrlPart(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    refuse(code);
  }
}

function normalizedHost(parsed) {
  return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function parsePort(value, code) {
  if (!/^[0-9]{1,5}$/.test(String(value || ""))) refuse(code);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) refuse(code);
  return String(port);
}

function connectionIdentity(parsed) {
  return Object.freeze({
    host: normalizedHost(parsed),
    port: parsed.port || "5432",
    database: decodeUrlPart(
      parsed.pathname.slice(1),
      "database_url_encoding_invalid"
    ),
    username: decodeUrlPart(
      parsed.username,
      "database_url_encoding_invalid"
    )
  });
}

function targetFingerprint(input) {
  const normalized = [
    "ia4tube-social-postgres-real-gate-v1",
    input.mode,
    String(input.environmentId || "").toLowerCase(),
    String(input.host || "").toLowerCase(),
    String(input.port || "5432"),
    String(input.database || ""),
    String(input.provisionerUsername || "").toLowerCase(),
    String(input.migrationUsername || "").toLowerCase(),
    String(input.runtimeUsername || "").toLowerCase(),
    input.mode === LOOPBACK_MODE ? "loopback" : "tls-verify-full",
    "disposable-empty-v1"
  ].join("/");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function equalFingerprint(actual, expected) {
  if (!SHA256.test(actual) || !SHA256.test(expected)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex")
  );
}

function parseDatabaseUrl(name, env, mode, expected) {
  const raw = requireValue(env, name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    refuse(`${name.toLowerCase()}_invalid`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.username ||
    (mode !== LOOPBACK_MODE && !parsed.password) ||
    !parsed.pathname ||
    parsed.pathname === "/"
  ) {
    refuse(`${name.toLowerCase()}_invalid`);
  }

  const identity = connectionIdentity(parsed);
  if (mode === LOOPBACK_MODE) {
    if (!LOOPBACK.has(identity.host)) {
      refuse(`${name.toLowerCase()}_invalid`);
    }
  } else {
    if (
      net.isIP(identity.host) !== 0 ||
      identity.host !== expected.host ||
      !identity.host.endsWith(".render.com") ||
      identity.port !== expected.port
    ) {
      refuse(`${name.toLowerCase()}_target_mismatch`);
    }
    const keys = [...new Set([...parsed.searchParams.keys()])];
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (
      keys.length !== 1 ||
      keys[0] !== "sslmode" ||
      sslModes.length !== 1 ||
      sslModes[0].toLowerCase() !== "verify-full"
    ) {
      refuse(`${name.toLowerCase()}_tls_invalid`);
    }
  }
  return Object.freeze({ parsed, raw, identity });
}

function secureConnection(raw, configuration) {
  const parsed = new URL(raw);
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.delete(key);
  }
  if (
    configuration.mode !== LOOPBACK_MODE &&
    (
      !configuration.ssl ||
      configuration.ssl.rejectUnauthorized !== true ||
      configuration.ssl.servername !== configuration.host ||
      Object.prototype.hasOwnProperty.call(configuration.ssl, "ca")
    )
  ) {
    refuse("system_trust_configuration_invalid");
  }
  return Object.freeze({
    connectionString: parsed.toString(),
    ssl:
      configuration.mode !== LOOPBACK_MODE
        ? configuration.ssl
        : false
  });
}

function validateGateEnvironment(env = process.env) {
  const {
    assertNoAmbientPostgresEnvironment,
    loadSystemPostgresTls,
    PAID_STAGING_PUBLIC_TARGET,
    DISPOSABLE_DATABASE_NAME
  } = gateDependencies();
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    refuse("node_tls_verification_disabled");
  }
  for (const [name, value] of Object.entries(env)) {
    if (/^PGSSL/i.test(name) && String(value || "").trim()) {
      refuse("ambient_pgssl_configuration_refused");
    }
  }
  try {
    assertNoAmbientPostgresEnvironment(
      env,
      "ambient_postgres_configuration_refused"
    );
  } catch (error) {
    if (
      error?.code === "ambient_postgres_configuration_refused"
    ) {
      refuse("ambient_postgres_configuration_refused");
    }
    throw error;
  }
  if (requireValue(env, "SOCIAL_TEST_POSTGRES_APPROVED") !== APPROVAL) {
    refuse("explicit_approval_missing");
  }
  for (const name of REQUIRED) requireValue(env, name);
  const environmentId = requireValue(env, "SOCIAL_TEST_ENVIRONMENT_ID")
    .toLowerCase();
  if (!UUID.test(environmentId)) refuse("environment_id_invalid");

  const mode = String(env.SOCIAL_TEST_TARGET_MODE || LOOPBACK_MODE)
    .trim()
    .toLowerCase();
  if (
    ![
      LOOPBACK_MODE,
      RENDER_REMOTE_MODE,
      RENDER_PAID_STAGING_DISPOSABLE_MODE
    ].includes(mode)
  ) {
    refuse("target_mode_invalid");
  }

  let expected = Object.freeze({});
  if (mode !== LOOPBACK_MODE) {
    const approval =
      mode === RENDER_REMOTE_MODE
        ? REMOTE_APPROVAL
        : PAID_STAGING_DISPOSABLE_APPROVAL;
    if (
      requireValue(env, "SOCIAL_TEST_RENDER_REMOTE_APPROVED") !== approval
    ) {
      refuse("remote_approval_missing");
    }
    for (const name of REMOTE_EXPECTED) requireValue(env, name);
    expected = Object.freeze({
      host: env.SOCIAL_TEST_EXPECTED_HOST.toLowerCase(),
      port: parsePort(
        env.SOCIAL_TEST_EXPECTED_PORT,
        "expected_port_invalid"
      ),
      database: env.SOCIAL_TEST_EXPECTED_DATABASE,
      usernames: Object.freeze([
        env.SOCIAL_TEST_EXPECTED_PROVISIONER_USERNAME,
        env.SOCIAL_TEST_EXPECTED_MIGRATION_USERNAME,
        env.SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME
      ]),
      fingerprint: env.SOCIAL_TEST_EXPECTED_TARGET_FINGERPRINT.toLowerCase()
    });
    const targetLabels = [expected.database, ...expected.usernames];
    const freeTargetInvalid =
      mode === RENDER_REMOTE_MODE &&
      (
        expected.database !== REMOTE_DATABASE ||
        targetLabels.some((label) => BLOCKED_LABEL.test(label))
      );
    const paidDisposableTargetInvalid =
      mode === RENDER_PAID_STAGING_DISPOSABLE_MODE &&
      (
        environmentId !== PAID_STAGING_PUBLIC_TARGET.environmentId ||
        expected.host !== PAID_STAGING_PUBLIC_TARGET.host ||
        expected.port !== PAID_STAGING_PUBLIC_TARGET.port ||
        expected.database !== DISPOSABLE_DATABASE_NAME ||
        expected.usernames[0] !==
          PAID_STAGING_PUBLIC_TARGET.provisionerLogin ||
        expected.usernames[1] !==
          PAID_STAGING_PUBLIC_TARGET.migrationLogin ||
        expected.usernames[2] !==
          PAID_STAGING_PUBLIC_TARGET.runtimeLogin ||
        targetLabels.some((label) => PRODUCTION_LABEL.test(label))
      );
    if (
      net.isIP(expected.host) !== 0 ||
      !expected.host.endsWith(".render.com") ||
      freeTargetInvalid ||
      paidDisposableTargetInvalid
    ) {
      refuse("expected_target_not_disposable");
    }
  }

  const urls = CONNECTION_NAMES.map((name) =>
    parseDatabaseUrl(name, env, mode, expected)
  );
  const identities = urls.map((item) => item.identity);
  if (new Set(urls.map((item) => item.raw)).size !== urls.length) {
    refuse("database_urls_must_be_distinct");
  }
  if (new Set(identities.map((item) => item.username)).size !== 3) {
    refuse("database_users_must_be_distinct");
  }
  for (const identity of identities.slice(1)) {
    if (
      identity.host !== identities[0].host ||
      identity.port !== identities[0].port ||
      identity.database !== identities[0].database
    ) {
      refuse("database_targets_must_match");
    }
  }

  if (mode === LOOPBACK_MODE) {
    if (
      !/^ia4tube_social_test_[a-z0-9_]+$/.test(identities[0].database) ||
      BLOCKED_LABEL.test(identities[0].database) ||
      identities.some((identity) => BLOCKED_LABEL.test(identity.username))
    ) {
      refuse("database_target_not_synthetic");
    }
  } else {
    if (
      identities[0].database !== expected.database ||
      identities.some(
        (identity, index) =>
          identity.username !== expected.usernames[index]
      )
    ) {
      refuse("database_identity_mismatch");
    }
    const actualFingerprint = targetFingerprint({
      mode,
      environmentId,
      host: expected.host,
      port: expected.port,
      database: expected.database,
      provisionerUsername: expected.usernames[0],
      migrationUsername: expected.usernames[1],
      runtimeUsername: expected.usernames[2]
    });
    if (!equalFingerprint(actualFingerprint, expected.fingerprint)) {
      refuse("external_target_fingerprint_mismatch");
    }
  }

  let ssl;
  if (mode !== LOOPBACK_MODE) {
    try {
      ssl = loadSystemPostgresTls(env, identities[0].host);
    } catch (error) {
      if (typeof error?.code === "string") refuse(error.code);
      throw error;
    }
  }
  const configuration = {
    mode,
    environmentId,
    host: identities[0].host,
    port: identities[0].port,
    database: identities[0].database,
    identities: Object.freeze(identities),
    urls: Object.freeze(urls.map((item) => item.raw)),
    fingerprint: targetFingerprint({
      mode,
      environmentId,
      host: identities[0].host,
      port: identities[0].port,
      database: identities[0].database,
      provisionerUsername: identities[0].username,
      migrationUsername: identities[1].username,
      runtimeUsername: identities[2].username
    })
  };
  if (ssl) {
    Object.defineProperty(configuration, "ssl", {
      value: ssl,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(configuration);
}

async function main(env = process.env, options = {}) {
  const writeLine = options.writeLine || ((line) => process.stdout.write(line));
  const validateGateEnvironmentImpl =
    options.validateGateEnvironmentImpl || validateGateEnvironment;
  const runNodeTestImpl = options.runNodeTestImpl || runNodeTest;
  let sequence = 0;
  function emit(event, fields) {
    sequence += 1;
    writeLine(safeEventLine({
      event,
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      sequence,
      ...fields
    }));
  }
  function emitFailure(firstFailureStage, failureFacts) {
    const effectiveFailureStage =
      failureFacts.firstFailureStage || firstFailureStage;
    const exact0004Evidence = exact0004EvidenceFromFacts(failureFacts);
    emit("failure", {
      failureDuringCleanup: failureFacts.failureDuringCleanup ?? false,
      failurePhase: failureFacts.failurePhase ?? null,
      firstFailureStage: effectiveFailureStage,
      safeErrorCode: failureFacts.safeErrorCode,
      safeModuleName: failureFacts.safeModuleName,
      safePermissionOrigin: failureFacts.safePermissionOrigin ?? "unknown",
      safeSourceBasename: failureFacts.safeSourceBasename ?? null,
      safeLineBucket: failureFacts.safeLineBucket ?? "unknown",
      stderrCategory: failureFacts.stderrCategory,
      ...exact0004Evidence
    });
  }

  emit("runnerReached", { runnerReached: true });
  let configuration;
  try {
    configuration = validateGateEnvironmentImpl(env);
  } catch (error) {
    if (error instanceof PostgresGateRefusal) {
      emitFailure("environment_gate", {
        stderrCategory: "environment_contract",
        safeErrorCode: "guard_failed",
        safeModuleName: null,
        safeSqlState: "unknown",
        safeErrorClass: "environment_contract"
      });
    } else {
      emitFailure("runner_load", safeFailureFromError(error));
    }
    return 2;
  }

  emit("gateValidated", { gateValidated: true });
  emit("nodeTestSpawnAttempted", { nodeTestSpawnAttempted: true });
  let result;
  try {
    result = await runNodeTestImpl({
      configuration,
      env,
      spawnImpl: options.spawnImpl || spawn,
      onCreated: () => emit("nodeTestProcessCreated", {
        nodeTestProcessCreated: true
      }),
      onMarker: (name) => emit(name, { [name]: true })
    });
  } catch (error) {
    emitFailure("node_test_spawn", safeFailureFromError(error));
    return 2;
  }

  if (!result.created || result.facts === null) {
    emitFailure(
      result.created ? "node_test_bootstrap" : "node_test_spawn",
      safeFailureFromError(result.error, "unknown")
    );
    return 2;
  }

  const resultErrorFailure = result.error
    ? safeFailureFromError(result.error)
    : null;
  const baseResultExact0004Evidence = exact0004EvidenceFromFacts(result.facts);
  const resultExact0004Evidence = {
    ...baseResultExact0004Evidence,
    ...(resultErrorFailure &&
      baseResultExact0004Evidence.exact0004FailureSubphase !== "not_reached"
      ? {
          safeSqlState: resultErrorFailure.safeSqlState,
          safeErrorClass: resultErrorFailure.safeErrorClass
        }
      : {})
  };
  emit("physicalPhaseSnapshot", {
    lastMainPhaseStarted: result.facts.lastMainPhaseStarted,
    lastMainPhaseCompleted: result.facts.lastMainPhaseCompleted,
    cleanupStarted: result.facts.cleanupStarted,
    cleanupCompleted: result.facts.cleanupCompleted,
    ...resultExact0004Evidence
  });
  const nodeTestTimedOut = result.signal === null ? false : null;
  emit("nodeTestClosed", {
    nodeTestExitCode: result.status,
    nodeTestSignal: result.signal,
    nodeTestTimedOut
  });
  let failureFacts;
  if (result.error) {
    const safeErrorFailure = resultErrorFailure;
    const errorBoundary = physicalFailureBoundary(result.facts);
    const firstFailureStage = safeErrorFailure.firstFailureStage ||
      (errorBoundary.failurePhase === null
        ? "node_test_bootstrap"
        : "safe_event_protocol");
    failureFacts = {
      ...(firstFailureStage === "safe_event_protocol"
        ? errorBoundary
        : emptyFailureBoundary()),
      ...resultExact0004Evidence,
      ...safeErrorFailure,
      firstFailureStage
    };
  } else {
    failureFacts = nodeTestFailure(result.facts, result);
  }
  if (failureFacts) {
    emitFailure(failureFacts.firstFailureStage, failureFacts);
    if (Number.isSafeInteger(result.status) && result.status !== 0) {
      return result.status;
    }
    return 1;
  }
  return 0;
}

let exact0004CheckpointWriteSequence = 0;

function exact0004CheckpointPaths(env = process.env) {
  if (typeof env.RUNNER_TEMP !== "string" || env.RUNNER_TEMP.length === 0) {
    throw Object.assign(new Error("exact0004_runner_temp_invalid"), {
      code: "exact0004_runner_temp_invalid"
    });
  }
  const temporaryRoot = path.resolve(env.RUNNER_TEMP);
  return Object.freeze({
    temporaryRoot,
    checkpoint: path.join(temporaryRoot, "exact0004-entry-checkpoint.json"),
    evidenceState: path.join(temporaryRoot, "exact0004-evidence-state.json"),
    processState: path.join(temporaryRoot, "exact0004-process-state.json"),
    cleanupState: path.join(temporaryRoot, "exact0004-cleanup-state.json"),
    assessment: path.join(temporaryRoot, "exact0004-transport-assessment.json"),
    artifactDirectory: path.join(
      temporaryRoot,
      "social-3b0-exact-0004-runner-linux-evidence"
    )
  });
}

function exact0004CheckpointDefaults() {
  return {
    checkpointSchemaVersion: EXACT_0004_CHECKPOINT_SCHEMA_VERSION,
    physicalStepAdmitted: false,
    physicalStepEntered: false,
    physicalScriptLoadAttempted: false,
    physicalScriptLoaded: false,
    physicalLauncherSpawnAttempted: false,
    physicalLauncherProcessCreated: false,
    physicalLauncherExitCode: null,
    physicalLauncherSignal: null,
    physicalLauncherTimedOut: null,
    postgresStartAttempted: false,
    postgresStarted: false,
    nodeTestSpawnAttempted: false,
    nodeTestProcessCreated: false,
    cleanupStarted: false,
    cleanupCompleted: false,
    auxiliaryProcessCount: 0,
    safeAuxiliaryProcessClass: "not_observed",
    auxiliaryProcessOwnedByRoute: false,
    firstFailureStage: null
  };
}

function validExact0004Checkpoint(value) {
  if (!exactKeys(value, EXACT_0004_CHECKPOINT_KEYS) ||
      value.checkpointSchemaVersion !== EXACT_0004_CHECKPOINT_SCHEMA_VERSION) {
    return false;
  }
  for (const key of [
    "physicalStepAdmitted",
    "physicalStepEntered",
    "physicalScriptLoadAttempted",
    "physicalScriptLoaded",
    "physicalLauncherSpawnAttempted",
    "physicalLauncherProcessCreated",
    "postgresStartAttempted",
    "postgresStarted",
    "nodeTestSpawnAttempted",
    "nodeTestProcessCreated",
    "cleanupStarted",
    "cleanupCompleted",
    "auxiliaryProcessOwnedByRoute"
  ]) {
    if (typeof value[key] !== "boolean") return false;
  }
  if (!Number.isSafeInteger(value.auxiliaryProcessCount) ||
      value.auxiliaryProcessCount < 0 || value.auxiliaryProcessCount > 1 ||
      !EXACT_0004_AUXILIARY_PROCESS_CLASSES.includes(
        value.safeAuxiliaryProcessClass
      ) ||
      !(value.firstFailureStage === null ||
        EXACT_0004_CHECKPOINT_FAILURE_STAGES.includes(
          value.firstFailureStage
        ))) {
    return false;
  }
  const noLauncherResult = value.physicalLauncherExitCode === null &&
    value.physicalLauncherSignal === null &&
    value.physicalLauncherTimedOut === null;
  const launcherExited = Number.isSafeInteger(value.physicalLauncherExitCode) &&
    value.physicalLauncherExitCode >= 0 &&
    value.physicalLauncherSignal === null &&
    typeof value.physicalLauncherTimedOut === "boolean";
  const launcherSignaled = value.physicalLauncherExitCode === null &&
    SAFE_SIGNALS.has(value.physicalLauncherSignal) &&
    typeof value.physicalLauncherTimedOut === "boolean";
  if (!noLauncherResult && !launcherExited && !launcherSignaled) return false;
  if (value.physicalStepEntered && !value.physicalStepAdmitted ||
      value.physicalScriptLoadAttempted && !value.physicalStepEntered ||
      value.physicalScriptLoaded && !value.physicalScriptLoadAttempted ||
      value.physicalLauncherSpawnAttempted && !value.physicalScriptLoaded ||
      value.physicalLauncherProcessCreated &&
        !value.physicalLauncherSpawnAttempted ||
      value.physicalLauncherProcessCreated &&
        !value.auxiliaryProcessOwnedByRoute ||
      value.postgresStartAttempted && !value.physicalScriptLoaded ||
      value.postgresStarted && !value.postgresStartAttempted ||
      value.nodeTestSpawnAttempted &&
        !value.physicalLauncherProcessCreated ||
      value.nodeTestProcessCreated && !value.nodeTestSpawnAttempted ||
      value.cleanupCompleted && !value.cleanupStarted ||
      value.auxiliaryProcessOwnedByRoute &&
        !value.physicalLauncherProcessCreated ||
      value.auxiliaryProcessCount > 0 &&
        value.safeAuxiliaryProcessClass === "not_observed") {
    return false;
  }
  if (value.physicalLauncherSpawnAttempted &&
      value.auxiliaryProcessOwnedByRoute &&
      value.safeAuxiliaryProcessClass !== "sudo") return false;
  if (!value.physicalLauncherProcessCreated && !noLauncherResult) return false;
  return true;
}

function readExact0004Json(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeExact0004FileAtomic(file, body) {
  exact0004CheckpointWriteSequence += 1;
  const temporaryFile = `${file}.tmp-${process.pid}-` +
    String(exact0004CheckpointWriteSequence);
  const descriptor = fs.openSync(temporaryFile, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryFile, file);
  let directoryDescriptor = null;
  try {
    directoryDescriptor = fs.openSync(path.dirname(file), "r");
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
  }
}

function writeExact0004JsonAtomic(file, value) {
  writeExact0004FileAtomic(file, JSON.stringify(value) + "\n");
}

function updateExact0004Checkpoint(patch, env = process.env) {
  const { checkpoint } = exact0004CheckpointPaths(env);
  const current = readExact0004Json(checkpoint);
  if (!validExact0004Checkpoint(current) ||
      patch === null || typeof patch !== "object" || Array.isArray(patch) ||
      Object.keys(patch).some((key) =>
        !EXACT_0004_CHECKPOINT_KEYS.includes(key) ||
        key === "checkpointSchemaVersion"
      )) {
    throw Object.assign(new Error("exact0004_checkpoint_invalid"), {
      code: "exact0004_checkpoint_invalid"
    });
  }
  const next = { ...current, ...patch };
  if (current.firstFailureStage !== null &&
      next.firstFailureStage !== current.firstFailureStage) {
    next.firstFailureStage = current.firstFailureStage;
  }
  if (!validExact0004Checkpoint(next)) {
    throw Object.assign(new Error("exact0004_checkpoint_transition_invalid"), {
      code: "exact0004_checkpoint_transition_invalid"
    });
  }
  writeExact0004JsonAtomic(checkpoint, next);
  return Object.freeze(next);
}

function initializeExact0004PhysicalCheckpoint(env = process.env) {
  const { checkpoint } = exact0004CheckpointPaths(env);
  const initial = exact0004CheckpointDefaults();
  if (!validExact0004Checkpoint(initial) || fs.existsSync(checkpoint)) {
    throw Object.assign(new Error("exact0004_checkpoint_initialization_refused"), {
      code: "exact0004_checkpoint_initialization_refused"
    });
  }
  writeExact0004JsonAtomic(checkpoint, initial);
  return 0;
}

function enterExact0004PhysicalStep(env = process.env) {
  updateExact0004Checkpoint({
    physicalStepAdmitted: true,
    physicalStepEntered: true
  }, env);
  return 0;
}

function attemptExact0004PhysicalScriptLoad(env = process.env) {
  updateExact0004Checkpoint({ physicalScriptLoadAttempted: true }, env);
  return 0;
}

function observeExact0004Checkpoint(patch, env = process.env) {
  try {
    updateExact0004Checkpoint(patch, env);
    return true;
  } catch (error) {
    if (!["exact0004_checkpoint_invalid",
      "exact0004_checkpoint_transition_invalid"].includes(error && error.code)) {
      try {
        updateExact0004Checkpoint({
          firstFailureStage: "physical_evidence"
        }, env);
      } catch {
        // The independent transport snapshot classifies any surviving atomic
        // temporary as partial while preserving the last valid checkpoint.
      }
    }
    return false;
  }
}

function startExact0004PhysicalObservation(env = process.env) {
  const initial = readExact0004Json(exact0004CheckpointPaths(env).checkpoint);
  if (!validExact0004Checkpoint(initial) ||
      initial.physicalStepEntered !== true ||
      initial.physicalScriptLoadAttempted !== true ||
      initial.physicalScriptLoaded !== false) {
    throw Object.assign(new Error("exact0004_checkpoint_load_refused"), {
      code: "exact0004_checkpoint_load_refused"
    });
  }
  updateExact0004Checkpoint({ physicalScriptLoaded: true }, env);
  let launcherProcessCreated = false;
  const observe = (patch) => observeExact0004Checkpoint(patch, env);
  const failure = (stage) => observe({
    firstFailureStage: EXACT_0004_CHECKPOINT_FAILURE_STAGES.includes(stage)
      ? stage
      : "unknown"
  });
  const safeEvent = (name, snapshot) => {
    if (name === "nodeTestSpawnAttempted") {
      observe({ nodeTestSpawnAttempted: true });
    } else if (name === "nodeTestProcessCreated") {
      observe({ nodeTestProcessCreated: true });
    } else if (name === "failure" && snapshot) {
      failure(snapshot.firstFailureStage);
    }
  };
  return Object.freeze({
    cleanupCompleted(completed, auxiliaryResiduals) {
      const auxiliaryProcessCount = Number.isSafeInteger(auxiliaryResiduals) &&
        auxiliaryResiduals > 0 ? 1 : 0;
      observe({
        cleanupCompleted: completed === true && auxiliaryProcessCount === 0,
        auxiliaryProcessCount,
        ...(completed === true ? {} : { firstFailureStage: "cleanup" })
      });
    },
    cleanupStarted() {
      observe({ cleanupStarted: true });
    },
    failure,
    launcherClosed(code, signal, timedOut, auxiliaryResiduals) {
      if (!launcherProcessCreated) return;
      observe({
        physicalLauncherExitCode: Number.isSafeInteger(code) ? code : null,
        physicalLauncherSignal: typeof signal === "string" ? signal : null,
        physicalLauncherTimedOut: timedOut === true,
        auxiliaryProcessCount: Number.isSafeInteger(auxiliaryResiduals) &&
          auxiliaryResiduals > 0 ? 1 : 0
      });
    },
    launcherProcessCreated() {
      launcherProcessCreated = true;
      observe({
        physicalLauncherProcessCreated: true,
        auxiliaryProcessCount: 1,
        auxiliaryProcessOwnedByRoute: true
      });
    },
    launcherSpawnAttempted() {
      observe({
        physicalLauncherSpawnAttempted: true,
        safeAuxiliaryProcessClass: "sudo"
      });
    },
    postgresStartAttempted() {
      observe({ postgresStartAttempted: true });
    },
    postgresStarted() {
      observe({ postgresStarted: true });
    },
    safeEvent
  });
}

function exact0004TemporaryFilesFor(file) {
  const directory = path.dirname(file);
  const prefix = path.basename(file) + ".tmp-";
  try {
    return fs.readdirSync(directory).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
}

function inspectExact0004JsonTransport(file, validator, parsedState = "valid") {
  const temporaryFiles = exact0004TemporaryFilesFor(file);
  if (!fs.existsSync(file)) {
    return Object.freeze({
      state: temporaryFiles.length === 0 ? "missing" : "partial",
      value: null
    });
  }
  const value = readExact0004Json(file);
  if (temporaryFiles.length !== 0) {
    return Object.freeze({ state: "partial", value });
  }
  if (value === null) return Object.freeze({ state: "partial", value: null });
  if (typeof validator === "function" && !validator(value)) {
    return Object.freeze({ state: "invalid", value });
  }
  return Object.freeze({ state: parsedState, value });
}

function validExact0004CleanupState(value) {
  const keys = [
    "cleanupCompleted",
    "containerResiduals",
    "volumeResiduals",
    "networkResiduals",
    "listenerResiduals",
    "temporaryRootResiduals"
  ];
  return exactKeys(value, keys) &&
    typeof value.cleanupCompleted === "boolean" &&
    keys.slice(1).every((key) =>
      Number.isSafeInteger(value[key]) && value[key] >= 0
    );
}

function writeExact0004CleanupState(value, env = process.env) {
  const projected = Object.fromEntries([
    "cleanupCompleted",
    "containerResiduals",
    "volumeResiduals",
    "networkResiduals",
    "listenerResiduals",
    "temporaryRootResiduals"
  ].map((key) => [key, value && value[key]]));
  if (!validExact0004CleanupState(projected)) {
    throw Object.assign(new Error("exact0004_cleanup_state_invalid"), {
      code: "exact0004_cleanup_state_invalid"
    });
  }
  writeExact0004JsonAtomic(
    exact0004CheckpointPaths(env).cleanupState,
    projected
  );
  return 0;
}

function validExact0004ProcessStatus(value) {
  const keys = [
    "exitCode", "signal", "timedOut", "stdoutStored", "stderrStored"
  ];
  if (!exactKeys(value, keys) || typeof value.timedOut !== "boolean" ||
      value.stdoutStored !== false || value.stderrStored !== false) return false;
  const noResult = value.exitCode === null && value.signal === null;
  const exited = Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 &&
    value.signal === null;
  const signaled = value.exitCode === null &&
    SAFE_SIGNALS.has(value.signal);
  return noResult || exited || signaled;
}

function snapshotExact0004PhysicalTransport(env = process.env) {
  const files = exact0004CheckpointPaths(env);
  const entry = inspectExact0004JsonTransport(
    files.checkpoint,
    validExact0004Checkpoint
  );
  const evidence = inspectExact0004JsonTransport(
    files.evidenceState,
    null,
    "present"
  );
  const status = inspectExact0004JsonTransport(
    files.processState,
    validExact0004ProcessStatus
  );
  const cleanup = inspectExact0004JsonTransport(
    files.cleanupState,
    validExact0004CleanupState
  );
  const assessment = {
    assessmentSchemaVersion: 1,
    entryCheckpointState: entry.state,
    physicalEvidenceTransportState: evidence.state,
    processStatusTransportState: status.state,
    cleanupState: cleanup.state,
    cleanup: cleanup.state === "valid"
      ? Object.fromEntries([
        "cleanupCompleted",
        "containerResiduals",
        "volumeResiduals",
        "networkResiduals",
        "listenerResiduals",
        "temporaryRootResiduals"
      ].map((key) => [key, cleanup.value[key]]))
      : null
  };
  writeExact0004JsonAtomic(files.assessment, assessment);
  return 0;
}

const EXACT_0004_LEGACY_ARTIFACT_KEYS = Object.freeze([
  "schemaVersion", "evidenceSchemaVersion", "branch", "commit", "parent",
  "inventory", "runner", "nodeVersion", "postgresImageDigest",
  "postgresStarted", "testProcessStarted", "testFileLoaded",
  "testsDiscovered", "testsPassed", "testsFailed", "planExactPassed",
  "applyExactPassed", "concurrencyPassed", "rollbackPassed", "profileBefore",
  "profileAfter", "firstFailure", "runnerReached", "gateValidated",
  "nodeTestSpawnAttempted", "nodeTestProcessCreated", "nodeTestExitCode",
  "nodeTestSignal", "nodeTestTimedOut", "tapStarted", "tapTitleObserved",
  "firstTestDiscovered", "stderrCategory", "safeErrorCode", "safeModuleName",
  "firstFailureStage", "lastMainPhaseStarted", "lastMainPhaseCompleted",
  "lastExact0004SubphaseStarted", "lastExact0004SubphaseCompleted",
  "exact0004FailureSubphase", "safeSqlState", "safeErrorClass",
  "safeOperationClass", "planExactInvoked", "planExactCompleted",
  "applyExactInvoked", "applyExactCompleted", "databaseMutationAttempted",
  "failureBeforeFirstMutation", "conflictingNegativeAttempted",
  "conflictingNegativePromiseOutcome", "conflictingNegativeObservedSqlState",
  "conflictingNegativeFulfilledResultClass",
  "conflictingNegativeAssertionMatched",
  "conflictingNegativeRejectedBeforeAssertion", "cleanupStarted",
  "failureDuringCleanup", "failurePhase", "safePermissionOrigin",
  "safeSourceBasename", "safeLineBucket", "cleanupCompleted", "residuals"
]);
const EXACT_0004_ARTIFACT_ADDED_KEYS = Object.freeze([
  "physicalEntryCheckpointState",
  "physicalEvidenceState",
  "physicalStepAdmitted",
  "physicalStepEntered",
  "physicalScriptLoadAttempted",
  "physicalScriptLoaded",
  "physicalLauncherSpawnAttempted",
  "physicalLauncherProcessCreated",
  "physicalLauncherExitCode",
  "physicalLauncherSignal",
  "physicalLauncherTimedOut",
  "postgresStartAttempted",
  "auxiliaryProcessCount",
  "safeAuxiliaryProcessClass",
  "auxiliaryProcessOwnedByRoute",
  "cleanupFailure"
]);
const EXACT_0004_ARTIFACT_KEYS = Object.freeze([
  ...EXACT_0004_LEGACY_ARTIFACT_KEYS,
  ...EXACT_0004_ARTIFACT_ADDED_KEYS
]);
const EXACT_0004_RESIDUAL_KEYS = Object.freeze([
  "containers", "volumes", "networks", "postgresProcesses",
  "auxiliaryProcesses", "listeners", "temp", "intermediateFiles"
]);
const EXACT_0004_INVENTORY = Object.freeze([
  ".github/workflows/social-3b0-exact-0004-runner-linux.yml",
  "db/migrations/0004_social_connector_persistence.up.sql",
  "db/migrations/checksums.json",
  "scripts/run-node-tests.js",
  "scripts/run-real-postgres-tests.js",
  "scripts/social-3a0p-local-scope.js",
  "scripts/social-db-migrate.js",
  "src/persistence/postgres/migrations.js",
  "tests/free_art_campaigns.test.js",
  "tests/free_art_campaigns_notifications.test.js",
  "tests/monthly_planning_photo_items.test.js",
  "tests/node-test-runner-safety.test.js",
  "tests/product_discovery.test.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-linux-workflow.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-exact-0004-runner-linux-workflow.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-postgres-migrations.test.js",
  "tests/social-postgres-real.test.js"
]);
const EXACT_0004_ARTIFACT_STATE_SET = new Set([
  "missing", "partial", "invalid", "valid"
]);
const EXACT_0004_ARTIFACT_FAILURE_STAGE_SET = new Set(
  EXACT_0004_CHECKPOINT_FAILURE_STAGES
);

function validExact0004ArtifactBoundary(value, failed) {
  if (!nullableMainPhase(value.lastMainPhaseStarted) ||
      !nullableMainPhase(value.lastMainPhaseCompleted) ||
      !exact0004EvidenceValid(value)) return false;
  const startedIndex = value.lastMainPhaseStarted === null ? -1 :
    PHYSICAL_MAIN_PHASES.indexOf(value.lastMainPhaseStarted);
  const completedIndex = value.lastMainPhaseCompleted === null ? -1 :
    PHYSICAL_MAIN_PHASES.indexOf(value.lastMainPhaseCompleted);
  const mainProgress = startedIndex - completedIndex;
  if (![0, 1].includes(mainProgress) ||
      value.failurePhase !== null &&
        value.failurePhase !== PHYSICAL_CLEANUP_PHASE &&
        (!PHYSICAL_MAIN_PHASE_SET.has(value.failurePhase) ||
          mainProgress !== 1 || value.failurePhase !== value.lastMainPhaseStarted) ||
      (value.failurePhase === PHYSICAL_CLEANUP_PHASE) !==
        (value.firstFailureStage === "cleanup")) return false;

  const exactMainIndex = PHYSICAL_MAIN_PHASES.indexOf(
    "exact_0004_plan_apply"
  );
  const exactBefore = startedIndex < exactMainIndex;
  const exactActive = startedIndex === exactMainIndex &&
    completedIndex === exactMainIndex - 1;
  const exactAfter = completedIndex >= exactMainIndex;
  const defaults = emptyExact0004Evidence();
  const exactDefaults = EXACT_0004_EVIDENCE_FIELDS.every(
    (field) => value[field] === defaults[field]
  );
  const exactFinal =
    value.lastExact0004SubphaseStarted === "final_snapshot" &&
    value.lastExact0004SubphaseCompleted === "final_snapshot" &&
    value.exact0004FailureSubphase === "not_reached" &&
    value.safeSqlState === "not_observed" &&
    value.safeErrorClass === "unknown" &&
    value.safeOperationClass === "unknown" &&
    value.planExactInvoked === true &&
    value.planExactCompleted === true &&
    value.applyExactInvoked === true &&
    value.applyExactCompleted === true &&
    value.databaseMutationAttempted === true &&
    value.failureBeforeFirstMutation === false &&
    conflictingNegativeSucceeded(value);
  if (exactBefore && !exactDefaults ||
      exactActive && value.exact0004FailureSubphase === "not_reached" ||
      exactAfter && !exactFinal ||
      (value.failurePhase === "exact_0004_plan_apply") !==
        (value.exact0004FailureSubphase !== "not_reached") ||
      value.exact0004FailureSubphase !== "not_reached" && !failed) return false;
  return true;
}

function validExact0004ArtifactFailure(value) {
  const failed = value.firstFailure !== null;
  if (!(value.firstFailure === null ||
      /^[a-z0-9_]{3,96}$/.test(value.firstFailure)) ||
      failed !== (value.firstFailureStage !== null) ||
      value.firstFailureStage !== null &&
        !EXACT_0004_ARTIFACT_FAILURE_STAGE_SET.has(value.firstFailureStage) ||
      value.stderrCategory !== null &&
        !STDERR_CATEGORY_SET.has(value.stderrCategory) ||
      value.safeErrorCode !== null &&
        !SAFE_ERROR_CODE_SET.has(value.safeErrorCode) ||
      value.safeModuleName !== null &&
        !SAFE_MODULE_NAME_SET.has(value.safeModuleName) ||
      value.safeModuleName !== null &&
        value.stderrCategory !== "module_not_found") return false;
  if (!failed) {
    return value.stderrCategory === null && value.safeErrorCode === null &&
      value.safeModuleName === null && value.failureDuringCleanup === false &&
      value.failurePhase === null && value.safePermissionOrigin === null &&
      value.safeSourceBasename === null && value.safeLineBucket === null;
  }
  if (value.stderrCategory === null ||
      !SAFE_PERMISSION_ORIGIN_SET.has(value.safePermissionOrigin) ||
      !safeSourceFieldsValid(
        value.safeSourceBasename,
        value.safeLineBucket
      )) return false;
  if (value.stderrCategory !== "permission_denied") {
    return value.safePermissionOrigin === "unknown" &&
      value.safeSourceBasename === null && value.safeLineBucket === "unknown";
  }
  if (value.failurePhase === null ||
      value.safeErrorCode !== null &&
        !SAFE_PERMISSION_CODE_SET.has(value.safeErrorCode)) return false;
  if (value.safeErrorCode === "42501") {
    return value.safePermissionOrigin === "postgres_sqlstate";
  }
  if (["EACCES", "EPERM"].includes(value.safeErrorCode)) {
    return ["os_filesystem", "os_process", "unknown"].includes(
      value.safePermissionOrigin
    );
  }
  return value.safeErrorCode === null &&
    value.safePermissionOrigin === "unknown";
}

function validExact0004Artifact(value) {
  if (!exactKeys(value, EXACT_0004_ARTIFACT_KEYS) ||
      value.schemaVersion !== EXACT_0004_ARTIFACT_SCHEMA_VERSION ||
      value.evidenceSchemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      typeof value.branch !== "string" || value.branch.length < 1 ||
      value.branch.length > 160 || /[\r\n]/.test(value.branch) ||
      !/^[0-9a-f]{40}$/.test(value.commit) ||
      !/^[0-9a-f]{40}$/.test(value.parent) ||
      !Array.isArray(value.inventory) ||
      JSON.stringify(value.inventory) !== JSON.stringify(EXACT_0004_INVENTORY) ||
      value.runner !== "ubuntu-24.04" ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(value.nodeVersion) ||
      !/^sha256:[0-9a-f]{64}$/.test(value.postgresImageDigest)) return false;
  for (const key of [
    "postgresStarted", "testProcessStarted", "planExactPassed",
    "applyExactPassed", "concurrencyPassed", "rollbackPassed",
    "nodeTestSpawnAttempted", "nodeTestProcessCreated", "cleanupStarted",
    "cleanupCompleted", "failureDuringCleanup", "physicalStepAdmitted",
    "physicalStepEntered", "physicalScriptLoadAttempted",
    "physicalScriptLoaded", "physicalLauncherSpawnAttempted",
    "physicalLauncherProcessCreated", "postgresStartAttempted",
    "auxiliaryProcessOwnedByRoute"
  ]) if (typeof value[key] !== "boolean") return false;
  for (const key of [
    "testFileLoaded", "runnerReached", "gateValidated", "tapStarted",
    "tapTitleObserved", "firstTestDiscovered"
  ]) if (![null, true].includes(value[key])) return false;
  for (const key of ["testsDiscovered", "testsPassed", "testsFailed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1) {
      return false;
    }
  }
  if (!value.nodeTestProcessCreated && (
    value.testsDiscovered !== 0 || value.testsPassed !== 0 ||
    value.testsFailed !== 0
  )) return false;
  if (!["not_observed", "0003"].includes(value.profileBefore) ||
      !["not_observed", "0004"].includes(value.profileAfter) ||
      value.testFileLoaded !== value.tapTitleObserved ||
      value.testsDiscovered !== (value.firstTestDiscovered === true ? 1 : 0) ||
      value.testsPassed === 1 && value.testsDiscovered !== 1 ||
      value.testsPassed === 1 && value.testsFailed === 1 ||
      value.gateValidated === true && value.runnerReached !== true ||
      value.nodeTestSpawnAttempted && value.physicalEvidenceState === "valid" &&
        value.gateValidated !== true ||
      value.nodeTestProcessCreated && !value.nodeTestSpawnAttempted ||
      value.tapStarted === true && !value.nodeTestProcessCreated ||
      value.tapTitleObserved === true && value.tapStarted !== true ||
      value.firstTestDiscovered === true && value.tapStarted !== true) return false;
  const noNodeResult = value.nodeTestExitCode === null &&
    value.nodeTestSignal === null && value.nodeTestTimedOut === null;
  const nodeExited = Number.isSafeInteger(value.nodeTestExitCode) &&
    value.nodeTestExitCode >= 0 && value.nodeTestSignal === null &&
    value.nodeTestTimedOut === false;
  const nodeSignaled = value.nodeTestExitCode === null &&
    SAFE_SIGNALS.has(value.nodeTestSignal) && value.nodeTestTimedOut === null;
  if (!noNodeResult && !nodeExited && !nodeSignaled ||
      !value.nodeTestProcessCreated && !noNodeResult) return false;
  const failed = value.firstFailure !== null;
  if (!validExact0004ArtifactFailure(value) ||
      !validExact0004ArtifactBoundary(value, failed) ||
      !EXACT_0004_ARTIFACT_STATE_SET.has(value.physicalEntryCheckpointState) ||
      !EXACT_0004_ARTIFACT_STATE_SET.has(value.physicalEvidenceState) ||
      value.physicalStepEntered && !value.physicalStepAdmitted ||
      value.physicalScriptLoadAttempted && !value.physicalStepEntered ||
      value.physicalScriptLoaded && !value.physicalScriptLoadAttempted ||
      value.physicalLauncherSpawnAttempted && !value.physicalScriptLoaded ||
      value.physicalLauncherProcessCreated &&
        !value.physicalLauncherSpawnAttempted ||
      value.physicalLauncherProcessCreated &&
        !value.auxiliaryProcessOwnedByRoute ||
      value.postgresStartAttempted && !value.physicalScriptLoaded ||
      value.postgresStarted && !value.postgresStartAttempted ||
      value.testProcessStarted && !value.physicalLauncherProcessCreated ||
      value.nodeTestSpawnAttempted && !value.physicalLauncherProcessCreated ||
      value.nodeTestProcessCreated && !value.nodeTestSpawnAttempted ||
      value.cleanupCompleted && !value.cleanupStarted ||
      !value.cleanupStarted && value.failureDuringCleanup ||
      value.cleanupFailure !== null && value.cleanupStarted &&
        !value.failureDuringCleanup ||
      !value.physicalStepAdmitted && (
        value.physicalStepEntered || value.physicalScriptLoadAttempted ||
        value.physicalScriptLoaded || value.physicalLauncherSpawnAttempted ||
        value.physicalLauncherProcessCreated || value.postgresStartAttempted ||
        value.postgresStarted || value.auxiliaryProcessCount !== 0 ||
        value.safeAuxiliaryProcessClass !== "not_observed" ||
        value.auxiliaryProcessOwnedByRoute
      )) return false;
  const noLauncherResult = value.physicalLauncherExitCode === null &&
    value.physicalLauncherSignal === null &&
    value.physicalLauncherTimedOut === null;
  const launcherExited = Number.isSafeInteger(value.physicalLauncherExitCode) &&
    value.physicalLauncherExitCode >= 0 &&
    value.physicalLauncherSignal === null &&
    typeof value.physicalLauncherTimedOut === "boolean";
  const launcherSignaled = value.physicalLauncherExitCode === null &&
    SAFE_SIGNALS.has(value.physicalLauncherSignal) &&
    typeof value.physicalLauncherTimedOut === "boolean";
  if ((!noLauncherResult && !launcherExited && !launcherSignaled) ||
      !value.physicalLauncherProcessCreated && !noLauncherResult ||
      !Number.isSafeInteger(value.auxiliaryProcessCount) ||
      value.auxiliaryProcessCount < 0 || value.auxiliaryProcessCount > 1 ||
      !EXACT_0004_AUXILIARY_PROCESS_CLASSES.includes(
        value.safeAuxiliaryProcessClass) ||
      value.physicalLauncherSpawnAttempted &&
        value.auxiliaryProcessOwnedByRoute &&
        value.safeAuxiliaryProcessClass !== "sudo" ||
      value.auxiliaryProcessOwnedByRoute &&
        !value.physicalLauncherProcessCreated ||
      value.auxiliaryProcessCount > 0 &&
        value.safeAuxiliaryProcessClass === "not_observed") return false;
  if (!exactKeys(value.residuals, EXACT_0004_RESIDUAL_KEYS) ||
      EXACT_0004_RESIDUAL_KEYS.some((key) =>
        !Number.isSafeInteger(value.residuals[key]) || value.residuals[key] < 0) ||
      value.residuals.auxiliaryProcesses !==
        (value.auxiliaryProcessOwnedByRoute ? value.auxiliaryProcessCount : 0)) {
    return false;
  }
  if (!(value.cleanupFailure === null ||
      EXACT_0004_CLEANUP_FAILURE_CODES.includes(value.cleanupFailure)) ||
      value.cleanupFailure === null && !value.cleanupCompleted ||
      value.cleanupFailure !== null &&
        value.cleanupFailure !== "physical_cleanup_incomplete" &&
        value.cleanupCompleted ||
      value.cleanupFailure === "physical_cleanup_incomplete" &&
        !value.cleanupStarted) return false;
  if (EXACT_0004_PHYSICAL_FAILURE_CODES.includes(value.firstFailure)) {
    const causal = {
      physical_step_not_admitted: !value.physicalStepAdmitted,
      physical_step_command_resolution_failed_prestart:
        value.physicalStepAdmitted && value.physicalStepEntered &&
          !value.physicalScriptLoadAttempted,
      physical_step_script_load_failed_prestart:
        value.physicalScriptLoadAttempted && !value.physicalScriptLoaded,
      physical_step_launcher_spawn_failed:
        value.physicalLauncherSpawnAttempted &&
          !value.physicalLauncherProcessCreated,
      physical_step_process_created_before_evidence_failure:
        value.physicalLauncherProcessCreated &&
          value.physicalEvidenceState !== "valid",
      physical_step_evidence_writer_failed:
        value.firstFailureStage === "physical_evidence",
      physical_step_cleanup_not_started:
        !value.cleanupStarted && (
          value.physicalLauncherProcessCreated || value.postgresStartAttempted
        ),
      physical_step_cleanup_incomplete_with_owned_auxiliary_process:
        value.cleanupStarted && !value.cleanupCompleted &&
          value.auxiliaryProcessOwnedByRoute && value.auxiliaryProcessCount > 0,
      physical_step_auxiliary_process_not_owned_by_route:
        !value.physicalLauncherProcessCreated &&
          !value.auxiliaryProcessOwnedByRoute &&
          value.auxiliaryProcessCount > 0 &&
          value.safeAuxiliaryProcessClass !== "not_observed" &&
          value.residuals.auxiliaryProcesses === 0,
      physical_step_failure_evidence_insufficient: true
    };
    if (causal[value.firstFailure] !== true) return false;
  }
  return true;
}

function validExact0004Assessment(value) {
  const states = new Set(["missing", "partial", "invalid", "valid"]);
  const evidenceStates = new Set([
    "missing", "partial", "invalid", "present", "valid"
  ]);
  return exactKeys(value, [
    "assessmentSchemaVersion",
    "entryCheckpointState",
    "physicalEvidenceTransportState",
    "processStatusTransportState",
    "cleanupState",
    "cleanup"
  ]) && value.assessmentSchemaVersion === 1 &&
    states.has(value.entryCheckpointState) &&
    evidenceStates.has(value.physicalEvidenceTransportState) &&
    evidenceStates.has(value.processStatusTransportState) &&
    states.has(value.cleanupState) &&
    (value.cleanupState === "valid"
      ? validExact0004CleanupState(value.cleanup)
      : value.cleanup === null);
}

function finalizeExact0004Artifact(env = process.env) {
  const files = exact0004CheckpointPaths(env);
  const assessment = readExact0004Json(files.assessment);
  if (!validExact0004Assessment(assessment)) {
    throw Object.assign(new Error("exact0004_transport_assessment_invalid"), {
      code: "exact0004_transport_assessment_invalid"
    });
  }
  const evidenceFile = path.join(files.artifactDirectory, "evidence.json");
  const evidenceSidecar = evidenceFile + ".sha256";
  const legacy = readExact0004Json(evidenceFile);
  if (!exactKeys(legacy, EXACT_0004_LEGACY_ARTIFACT_KEYS)) {
    throw Object.assign(new Error("exact0004_legacy_artifact_invalid"), {
      code: "exact0004_legacy_artifact_invalid"
    });
  }
  const entryCandidate = readExact0004Json(files.checkpoint);
  const entryCheckpointValid = validExact0004Checkpoint(entryCandidate);
  const checkpointDefaults = exact0004CheckpointDefaults();
  const entry = entryCheckpointValid
    ? entryCandidate
    : checkpointDefaults;
  const checkpointPhysicalMarkersObserved = entryCheckpointValid &&
    EXACT_0004_CHECKPOINT_KEYS.slice(1).some(
      (key) => entry[key] !== checkpointDefaults[key]
    );
  const legacyEvidenceFallback =
    legacy.firstFailure === "physical_step_no_evidence" &&
    legacy.firstFailureStage === "artifact";
  const legacyStatusFallback = legacy.firstFailure === "process_status_invalid" &&
    legacy.firstFailureStage === "artifact";
  const legacyCleanupFallback = [
    "final_cleanup_incomplete", "final_residuals_nonzero"
  ].includes(legacy.firstFailure) && legacy.firstFailureStage === "cleanup";
  const legacyFallback = legacyEvidenceFallback || legacyStatusFallback ||
    legacyCleanupFallback;
  const evidenceTransportState =
    assessment.physicalEvidenceTransportState === "present"
      ? legacyEvidenceFallback ? "invalid" : "valid"
      : assessment.physicalEvidenceTransportState;
  const statusTransportState = assessment.processStatusTransportState === "present"
    ? legacyStatusFallback ? "invalid" : "valid"
    : assessment.processStatusTransportState;
  const physicalEvidenceState = evidenceTransportState !== "valid"
    ? evidenceTransportState
    : statusTransportState;
  const cleanup = assessment.cleanupState === "valid"
    ? assessment.cleanup
    : null;
  const cleanupCounter = (name) => cleanup &&
    Number.isSafeInteger(cleanup[name]) ? cleanup[name] : 1;
  const physicalStepAdmitted = ["success", "failure", "cancelled"].includes(
    env.PHYSICAL_OUTCOME
  ) || checkpointPhysicalMarkersObserved;
  const physicalStepEntered = physicalStepAdmitted &&
    entry.physicalStepEntered === true;
  const physicalScriptLoadAttempted = physicalStepEntered &&
    entry.physicalScriptLoadAttempted === true;
  const physicalScriptLoaded = physicalScriptLoadAttempted &&
    entry.physicalScriptLoaded === true;
  const physicalLauncherSpawnAttempted = physicalScriptLoaded &&
    entry.physicalLauncherSpawnAttempted === true;
  const physicalLauncherProcessCreated = physicalLauncherSpawnAttempted &&
    entry.physicalLauncherProcessCreated === true;
  const auxiliaryProcessOwnedByRoute = physicalLauncherProcessCreated &&
    entry.auxiliaryProcessOwnedByRoute === true;
  const auxiliaryProcessCount = physicalStepAdmitted
    ? entry.auxiliaryProcessCount
    : 0;
  const residuals = {
    containers: cleanupCounter("containerResiduals"),
    volumes: cleanupCounter("volumeResiduals"),
    networks: cleanupCounter("networkResiduals"),
    postgresProcesses: cleanupCounter("containerResiduals"),
    auxiliaryProcesses: auxiliaryProcessOwnedByRoute
      ? auxiliaryProcessCount
      : 0,
    listeners: cleanupCounter("listenerResiduals"),
    temp: cleanupCounter("temporaryRootResiduals"),
    intermediateFiles: 0
  };
  const residualsZero = Object.values(residuals).every((value) => value === 0);
  const cleanupStarted = entry.cleanupStarted === true || cleanup !== null;
  const cleanupCompleted = cleanupStarted && cleanup !== null &&
    cleanup.cleanupCompleted === true && residualsZero;
  const physicalCleanupFailureObserved = entryCheckpointValid &&
    physicalScriptLoaded && entry.cleanupStarted === true &&
    entry.cleanupCompleted === false;
  let firstFailure = legacyFallback ? null : legacy.firstFailure;
  let firstFailureStage = legacyFallback ? null : legacy.firstFailureStage;
  let physicalFailureRefinedLegacy = false;
  const physicalFailureRefinesLegacy = (code, stage) => {
    if (!entryCheckpointValid || entry.firstFailureStage !== stage) return false;
    if (code === "physical_step_launcher_spawn_failed") {
      return legacy.firstFailure === "exact0004_orchestration_failed" &&
        legacy.firstFailureStage === "composed_process";
    }
    if (code ===
        "physical_step_cleanup_incomplete_with_owned_auxiliary_process") {
      return [
        "auxiliary_process_cleanup_failed",
        "linux_cleanup_incomplete"
      ].includes(legacy.firstFailure) && legacy.firstFailureStage === "cleanup";
    }
    return false;
  };
  const recordFirstFailure = (code, stage) => {
    if (firstFailure === null && firstFailureStage === null) {
      firstFailure = code;
      firstFailureStage = stage;
      return;
    }
    if (physicalFailureRefinesLegacy(code, stage)) {
      firstFailure = code;
      firstFailureStage = stage;
      physicalFailureRefinedLegacy = true;
    }
  };
  let cleanupFailure = null;
  if (physicalCleanupFailureObserved) {
    cleanupFailure = "physical_cleanup_incomplete";
  } else if (!cleanupCompleted) {
    cleanupFailure = cleanup === null
      ? `final_cleanup_state_${assessment.cleanupState}`
      : residualsZero
        ? "final_cleanup_incomplete"
        : "final_residuals_nonzero";
  }
  const insufficient = (stage = "physical_evidence") => ({
    code: "physical_step_failure_evidence_insufficient",
    stage
  });
  const classifyPhysicalFailure = () => {
    if (env.PHYSICAL_OUTCOME === "skipped") {
      if (checkpointPhysicalMarkersObserved || ["partial", "invalid"].includes(
        assessment.entryCheckpointState
      )) return insufficient("physical_admission");
      return {
        code: "physical_step_not_admitted",
        stage: "physical_admission"
      };
    }
    if (entryCheckpointValid && [
      "postgres_start",
      "postgres_bootstrap",
      "composed_process",
      "npm",
      "runner_load",
      "environment_gate",
      "node_test_spawn",
      "node_test_bootstrap",
      "tap_start",
      "test_discovery",
      "test_execution",
      "safe_event_protocol",
      "physical_timeout"
    ].includes(entry.firstFailureStage)) {
      return insufficient(entry.firstFailureStage);
    }
    if (physicalLauncherProcessCreated && physicalEvidenceState !== "valid") {
      return {
        code: "physical_step_process_created_before_evidence_failure",
        stage: "physical_evidence"
      };
    }
    if (entryCheckpointValid && entry.firstFailureStage !== null) {
      if (entry.firstFailureStage === "cleanup") {
        if (!cleanupStarted) {
          return {
            code: "physical_step_cleanup_not_started",
            stage: "cleanup"
          };
        }
        if (auxiliaryProcessOwnedByRoute && auxiliaryProcessCount > 0) {
          return {
            code:
              "physical_step_cleanup_incomplete_with_owned_auxiliary_process",
            stage: "cleanup"
          };
        }
        return insufficient("cleanup");
      }
      if (entry.firstFailureStage === "physical_evidence") {
        return {
          code: "physical_step_evidence_writer_failed",
          stage: "physical_evidence"
        };
      }
      if (!["physical_admission", "physical_entry", "physical_script_load",
        "physical_launcher_spawn"].includes(entry.firstFailureStage)) {
        return insufficient(entry.firstFailureStage);
      }
    }
    if (assessment.entryCheckpointState === "partial") {
      return {
        code: "physical_step_evidence_writer_failed",
        stage: "physical_evidence"
      };
    }
    if (!entryCheckpointValid) return insufficient();
    if (physicalStepEntered && !physicalScriptLoadAttempted) {
      return {
        code: "physical_step_command_resolution_failed_prestart",
        stage: "physical_entry"
      };
    }
    if (physicalScriptLoadAttempted && !physicalScriptLoaded) {
      return {
        code: "physical_step_script_load_failed_prestart",
        stage: "physical_script_load"
      };
    }
    if (physicalLauncherSpawnAttempted && !physicalLauncherProcessCreated) {
      return {
        code: "physical_step_launcher_spawn_failed",
        stage: "physical_launcher_spawn"
      };
    }
    if (!physicalStepAdmitted) {
      return insufficient("physical_admission");
    }
    if (!physicalStepEntered) {
      return insufficient("physical_entry");
    }
    if (assessment.entryCheckpointState !== "valid") return insufficient();
    if (physicalEvidenceState === "partial") {
      return {
        code: "physical_step_evidence_writer_failed",
        stage: "physical_evidence"
      };
    }
    if (physicalEvidenceState !== "valid") return insufficient();
    if (env.PHYSICAL_OUTCOME === "failure" && firstFailure === null &&
        !physicalLauncherProcessCreated &&
        !auxiliaryProcessOwnedByRoute && auxiliaryProcessCount > 0 &&
        entry.safeAuxiliaryProcessClass !== "not_observed") {
      return {
        code: "physical_step_auxiliary_process_not_owned_by_route",
        stage: "artifact"
      };
    }
    const attributableResourceCreated = physicalLauncherProcessCreated ||
      entry.postgresStartAttempted === true;
    if (attributableResourceCreated && !cleanupStarted) {
      return {
        code: "physical_step_cleanup_not_started",
        stage: "cleanup"
      };
    }
    if (!cleanupCompleted && auxiliaryProcessOwnedByRoute &&
        auxiliaryProcessCount > 0) {
      return {
        code: "physical_step_cleanup_incomplete_with_owned_auxiliary_process",
        stage: "cleanup"
      };
    }
    if (env.CLEANUP_OUTCOME !== "success") return insufficient("cleanup");
    if (env.TRANSPORT_OUTCOME !== "success" ||
        env.LEGACY_FINALIZE_OUTCOME !== "success") {
      return insufficient("artifact");
    }
    if (cleanupFailure !== null || env.PHYSICAL_OUTCOME !== "success") {
      return insufficient(cleanupFailure !== null ? "cleanup" : "unknown");
    }
    return null;
  };
  const physicalFailure = classifyPhysicalFailure();
  if (physicalFailure !== null) {
    if (!EXACT_0004_PHYSICAL_FAILURE_CODES.includes(physicalFailure.code)) {
      throw new Error("exact0004_physical_failure_class_invalid");
    }
    recordFirstFailure(physicalFailure.code, physicalFailure.stage);
  }
  const physicalEvidenceValid = physicalEvidenceState === "valid";
  const nodeTestSpawnAttempted = physicalLauncherProcessCreated &&
    (entry.nodeTestSpawnAttempted === true ||
      physicalEvidenceValid && legacy.nodeTestSpawnAttempted === true);
  const nodeTestProcessCreated = physicalLauncherProcessCreated &&
    (entry.nodeTestProcessCreated === true ||
      physicalEvidenceValid && legacy.nodeTestProcessCreated === true);
  const artifact = {
    ...legacy,
    schemaVersion: EXACT_0004_ARTIFACT_SCHEMA_VERSION,
    testsDiscovered: nodeTestProcessCreated ? legacy.testsDiscovered : 0,
    testsPassed: nodeTestProcessCreated ? legacy.testsPassed : 0,
    testsFailed: nodeTestProcessCreated ? legacy.testsFailed : 0,
    postgresStarted: physicalScriptLoaded &&
      (entry.postgresStarted === true ||
        physicalEvidenceValid && legacy.postgresStarted === true),
    nodeTestSpawnAttempted,
    nodeTestProcessCreated,
    cleanupStarted,
    cleanupCompleted,
    firstFailure,
    firstFailureStage,
    failureDuringCleanup: (!legacyCleanupFallback &&
      legacy.failureDuringCleanup === true) ||
      physicalCleanupFailureObserved ||
      (cleanupStarted && cleanupFailure !== null),
    failurePhase: firstFailureStage === "cleanup"
      ? "final_cleanup"
      : physicalFailureRefinedLegacy || legacy.failurePhase === "final_cleanup"
        ? null
        : legacy.failurePhase,
    stderrCategory: physicalFailureRefinedLegacy
      ? "unknown"
      : firstFailure !== null && legacy.stderrCategory === null
      ? "unknown"
      : legacy.stderrCategory,
    safeErrorCode: physicalFailureRefinedLegacy ? null : legacy.safeErrorCode,
    safeModuleName: physicalFailureRefinedLegacy ? null : legacy.safeModuleName,
    safePermissionOrigin: physicalFailureRefinedLegacy
      ? "unknown"
      : firstFailure !== null && legacy.safePermissionOrigin === null
        ? "unknown"
        : legacy.safePermissionOrigin,
    safeSourceBasename: physicalFailureRefinedLegacy
      ? null
      : legacy.safeSourceBasename,
    safeLineBucket: physicalFailureRefinedLegacy
      ? "unknown"
      : firstFailure !== null && legacy.safeLineBucket === null
        ? "unknown"
        : legacy.safeLineBucket,
    residuals,
    physicalEntryCheckpointState: assessment.entryCheckpointState,
    physicalEvidenceState,
    physicalStepAdmitted,
    physicalStepEntered,
    physicalScriptLoadAttempted,
    physicalScriptLoaded,
    physicalLauncherSpawnAttempted,
    physicalLauncherProcessCreated,
    physicalLauncherExitCode: physicalLauncherProcessCreated
      ? entry.physicalLauncherExitCode
      : null,
    physicalLauncherSignal: physicalLauncherProcessCreated
      ? entry.physicalLauncherSignal
      : null,
    physicalLauncherTimedOut: physicalLauncherProcessCreated
      ? entry.physicalLauncherTimedOut
      : null,
    postgresStartAttempted: physicalScriptLoaded &&
      (entry.postgresStartAttempted === true ||
        physicalEvidenceValid && legacy.postgresStarted === true),
    auxiliaryProcessCount,
    safeAuxiliaryProcessClass: !physicalStepAdmitted
      ? "not_observed"
      : entryCheckpointValid
      ? entry.safeAuxiliaryProcessClass
      : "unknown",
    auxiliaryProcessOwnedByRoute,
    cleanupFailure
  };
  if (!validExact0004Artifact(artifact)) {
    throw Object.assign(new Error("exact0004_artifact_schema_invalid"), {
      code: "exact0004_artifact_schema_invalid"
    });
  }
  writeExact0004JsonAtomic(evidenceFile, artifact);
  const body = fs.readFileSync(evidenceFile);
  const sidecarBody = crypto.createHash("sha256").update(body).digest("hex") +
    "  evidence.json\n";
  writeExact0004FileAtomic(evidenceSidecar, sidecarBody);
  const consumedTransportFiles = [
    files.checkpoint,
    files.assessment,
    files.evidenceState,
    files.processState,
    files.cleanupState
  ];
  for (const file of consumedTransportFiles) {
    fs.rmSync(file, { force: true });
    for (const temporary of exact0004TemporaryFilesFor(file)) {
      fs.rmSync(path.join(path.dirname(file), temporary), { force: true });
    }
  }
  if (consumedTransportFiles.some((file) => fs.existsSync(file) ||
      exact0004TemporaryFilesFor(file).length !== 0)) {
    throw Object.assign(new Error("exact0004_intermediate_cleanup_failed"), {
      code: "exact0004_intermediate_cleanup_failed"
    });
  }
  return 0;
}

function enforceExact0004Artifact(env = process.env) {
  const files = exact0004CheckpointPaths(env);
  let validationFailure = null;
  try {
    const expectedFiles = [
      "evidence.json",
      "evidence.json.sha256",
      "process-status.json",
      "process-status.json.sha256"
    ];
    const actualFiles = fs.readdirSync(files.artifactDirectory).sort();
    if (JSON.stringify(actualFiles) !==
        JSON.stringify([...expectedFiles].sort())) {
      throw new Error("exact0004_artifact_inventory_invalid");
    }
    for (const name of expectedFiles) {
      const stat = fs.lstatSync(path.join(files.artifactDirectory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("exact0004_artifact_file_invalid");
      }
    }
    for (const name of ["evidence.json", "process-status.json"]) {
      const body = fs.readFileSync(path.join(files.artifactDirectory, name));
      const digest = crypto.createHash("sha256").update(body).digest("hex");
      const sidecar = fs.readFileSync(
        path.join(files.artifactDirectory, name + ".sha256"),
        "utf8"
      );
      if (sidecar !== `${digest}  ${name}\n`) {
        throw new Error("exact0004_artifact_hash_invalid");
      }
    }
    const evidence = readExact0004Json(
      path.join(files.artifactDirectory, "evidence.json")
    );
    const status = readExact0004Json(
      path.join(files.artifactDirectory, "process-status.json")
    );
    const imageReference = env.SOCIAL_EXACT_POSTGRES_IMAGE;
    const imageSeparator = typeof imageReference === "string"
      ? imageReference.lastIndexOf("@")
      : -1;
    const expectedImageDigest = imageSeparator > 0
      ? imageReference.slice(imageSeparator + 1)
      : null;
    if (!validExact0004Artifact(evidence) ||
        evidence.branch !== env.SOCIAL_EXACT_BRANCH ||
        evidence.commit !== env.GITHUB_SHA ||
        evidence.parent !== env.SOCIAL_EXACT_PARENT ||
        evidence.runner !== "ubuntu-24.04" ||
        !/^v24\./.test(evidence.nodeVersion) ||
        evidence.postgresImageDigest !== expectedImageDigest ||
        evidence.physicalEntryCheckpointState !== "valid" ||
        evidence.physicalEvidenceState !== "valid") {
      throw new Error("exact0004_artifact_identity_invalid");
    }
    for (const key of [
      "physicalStepAdmitted",
      "physicalStepEntered",
      "physicalScriptLoadAttempted",
      "physicalScriptLoaded",
      "physicalLauncherSpawnAttempted",
      "physicalLauncherProcessCreated",
      "postgresStartAttempted",
      "postgresStarted",
      "testProcessStarted",
      "testFileLoaded",
      "planExactPassed",
      "applyExactPassed",
      "concurrencyPassed",
      "rollbackPassed",
      "runnerReached",
      "gateValidated",
      "nodeTestSpawnAttempted",
      "nodeTestProcessCreated",
      "tapStarted",
      "tapTitleObserved",
      "firstTestDiscovered",
      "cleanupStarted",
      "cleanupCompleted"
    ]) {
      if (evidence[key] !== true) {
        throw new Error("exact0004_artifact_required_marker_invalid");
      }
    }
    const exactResult = {
      testsDiscovered: 1,
      testsPassed: 1,
      testsFailed: 0,
      profileBefore: "0003",
      profileAfter: "0004",
      nodeTestExitCode: 0,
      nodeTestSignal: null,
      nodeTestTimedOut: false,
      stderrCategory: null,
      safeErrorCode: null,
      safeModuleName: null,
      firstFailure: null,
      firstFailureStage: null,
      lastMainPhaseStarted: "reauthentication",
      lastMainPhaseCompleted: "reauthentication",
      lastExact0004SubphaseStarted: "final_snapshot",
      lastExact0004SubphaseCompleted: "final_snapshot",
      exact0004FailureSubphase: "not_reached",
      safeSqlState: "not_observed",
      safeErrorClass: "unknown",
      safeOperationClass: "unknown",
      planExactInvoked: true,
      planExactCompleted: true,
      applyExactInvoked: true,
      applyExactCompleted: true,
      databaseMutationAttempted: true,
      failureBeforeFirstMutation: false,
      conflictingNegativeAttempted: true,
      conflictingNegativePromiseOutcome: "rejected",
      conflictingNegativeObservedSqlState: "23514",
      conflictingNegativeFulfilledResultClass: "not_observed",
      conflictingNegativeAssertionMatched: true,
      conflictingNegativeRejectedBeforeAssertion: true,
      failureDuringCleanup: false,
      failurePhase: null,
      safePermissionOrigin: null,
      safeSourceBasename: null,
      safeLineBucket: null,
      physicalLauncherExitCode: 0,
      physicalLauncherSignal: null,
      physicalLauncherTimedOut: false,
      auxiliaryProcessCount: 0,
      safeAuxiliaryProcessClass: "sudo",
      auxiliaryProcessOwnedByRoute: true,
      cleanupFailure: null
    };
    for (const [key, expected] of Object.entries(exactResult)) {
      if (evidence[key] !== expected) {
        throw new Error("exact0004_artifact_result_invalid");
      }
    }
    if (evidence.testFileLoaded !== evidence.tapTitleObserved ||
        EXACT_0004_RESIDUAL_KEYS.some((key) => evidence.residuals[key] !== 0)) {
      throw new Error("exact0004_artifact_result_invalid");
    }
    if (!validExact0004ProcessStatus(status) || status.exitCode !== 0 ||
        status.signal !== null || status.timedOut !== false ||
        status.stdoutStored !== false || status.stderrStored !== false ||
        status.exitCode !== evidence.physicalLauncherExitCode ||
        status.signal !== evidence.physicalLauncherSignal ||
        status.timedOut !== evidence.physicalLauncherTimedOut) {
      throw new Error("exact0004_process_status_invalid");
    }
    for (const name of [
      "ENTRY_OUTCOME",
      "PHYSICAL_OUTCOME",
      "CLEANUP_OUTCOME",
      "TRANSPORT_OUTCOME",
      "LEGACY_FINALIZE_OUTCOME",
      "FINALIZE_OUTCOME",
      "UPLOAD_OUTCOME"
    ]) {
      if (env[name] !== "success") {
        throw new Error("exact0004_step_outcome_failed");
      }
    }
  } catch (error) {
    validationFailure = error;
  }
  let cleanupFailure = null;
  try {
    fs.rmSync(files.artifactDirectory, { recursive: true, force: true });
    if (fs.existsSync(files.artifactDirectory)) {
      throw new Error("exact0004_artifact_cleanup_failed");
    }
  } catch (error) {
    cleanupFailure = error;
  }
  let worktreeFailure = null;
  try {
    const worktreeStatus = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0"
        }
      }
    );
    if (worktreeStatus !== "") throw new Error("exact0004_worktree_not_clean");
  } catch (error) {
    worktreeFailure = error;
  }
  if (validationFailure) throw validationFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (worktreeFailure) throw worktreeFailure;
  return 0;
}

if (require.main === module) {
  const mode = process.argv[2];
  const operation = mode === "--exact-0004-checkpoint-init"
    ? () => initializeExact0004PhysicalCheckpoint()
    : mode === "--exact-0004-checkpoint-enter"
      ? () => enterExact0004PhysicalStep()
      : mode === "--exact-0004-checkpoint-load-attempt"
        ? () => attemptExact0004PhysicalScriptLoad()
        : mode === "--exact-0004-transport-snapshot"
          ? () => snapshotExact0004PhysicalTransport()
          : mode === "--exact-0004-artifact-finalize"
            ? () => finalizeExact0004Artifact()
            : mode === "--exact-0004-artifact-enforce"
              ? () => enforceExact0004Artifact()
              : () => main();
  Promise.resolve().then(operation).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = 2; }
  );
}

module.exports = {
  APPROVAL,
  CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES,
  CONFLICTING_NEGATIVE_PROMISE_OUTCOMES,
  EVIDENCE_SCHEMA_VERSION,
  EXACT_0004_ARTIFACT_ADDED_KEYS,
  EXACT_0004_ARTIFACT_KEYS,
  EXACT_0004_ARTIFACT_SCHEMA_VERSION,
  EXACT_0004_AUXILIARY_PROCESS_CLASSES,
  EXACT_0004_CLEANUP_FAILURE_CODES,
  EXACT_0004_CHECKPOINT_FAILURE_STAGES,
  EXACT_0004_CHECKPOINT_KEYS,
  EXACT_0004_CHECKPOINT_SCHEMA_VERSION,
  EXACT_0004_PHYSICAL_FAILURE_CODES,
  EXACT_0004_ERROR_CLASSES,
  EXACT_0004_EVIDENCE_FIELDS,
  EXACT_0004_EXECUTION_SUBPHASES,
  EXACT_0004_INVENTORY,
  EXACT_0004_OPERATION_CLASSES,
  EXACT_0004_SUBPHASES,
  EXACT_0004_RESIDUAL_KEYS,
  FIRST_FAILURE_STAGES,
  LOOPBACK_MODE,
  PHYSICAL_CLEANUP_PHASE,
  PHYSICAL_MAIN_PHASES,
  PHYSICAL_PHASES,
  PAID_STAGING_DISPOSABLE_APPROVAL,
  PostgresGateRefusal,
  REMOTE_APPROVAL,
  REMOTE_DATABASE,
  RENDER_PAID_STAGING_DISPOSABLE_MODE,
  RENDER_REMOTE_MODE,
  SAFE_ERROR_CODES,
  SAFE_EVENT_PREFIX,
  SAFE_LINE_BUCKETS,
  SAFE_MODULE_NAMES,
  SAFE_PERMISSION_CODES,
  SAFE_PERMISSION_ORIGINS,
  SAFE_SQL_STATES,
  SAFE_SQL_STATE_VALUES,
  SAFE_SOURCE_BASENAMES,
  STDERR_CATEGORIES,
  TAP_TITLE,
  attemptExact0004PhysicalScriptLoad,
  canonicalJson,
  classifySafeLine,
  createNodeTestObserver,
  createPhysicalPhaseEmitter,
  createPhysicalPhaseProtocol,
  createSafeDiagnosticAggregator,
  createSafeEventCollector,
  conflictingNegativeEvidenceValid,
  emptyConflictingNegativeEvidence,
  emptyExact0004Evidence,
  exact0004EvidenceValid,
  exact0004CheckpointDefaults,
  exact0004CheckpointPaths,
  exact0004OperationClass,
  enterExact0004PhysicalStep,
  enforceExact0004Artifact,
  finalizeExact0004Artifact,
  inspectExact0004JsonTransport,
  initializeExact0004PhysicalCheckpoint,
  main,
  observeExact0004Checkpoint,
  runNodeTest,
  safeEventLine,
  safeLineBucket,
  secureConnection,
  snapshotExact0004PhysicalTransport,
  startExact0004PhysicalObservation,
  targetFingerprint,
  updateExact0004Checkpoint,
  validExact0004Assessment,
  validExact0004Artifact,
  validExact0004Checkpoint,
  validExact0004CleanupState,
  validExact0004ProcessStatus,
  validateGateEnvironment,
  writeExact0004CleanupState
};
