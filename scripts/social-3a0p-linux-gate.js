"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runLinuxDurabilityProof } = require("./social-3a0p-linux-durability");
const {
  BACKUP_CONNECTIVITY_MODE,
  DATABASE,
  IMAGE,
  IMAGE_DIGEST,
  LOOPBACK,
  MIGRATION_LOGIN,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  commandRunner,
  createLinuxPostgres,
  postgresFailureDiagnostics
} = require("./social-3a0p-linux-postgres");
const {
  databaseContainsMarker,
  runConcurrencyOAuthIdempotencyGate,
  runPersistedVaultGate,
  runRlsAndRoleGate,
  runRlsPrivilegeInventoryContextReproduction,
  runRlsRuntimeWriteContractReproduction,
  runRuntimeAttributesTextResolutionReproduction,
  runVaultSupplementalGate
} = require("./social-3a0p-linux-physical-gates");
const {
  assertSessionMetricsSafe,
  collectSessionMetrics,
  createPoolMetricsRegistry
} = require("./social-3a0p-local-runtime-evidence-metrics");

const BRANCH =
  "social/checkpoint-3a0p-gate5-profile-constraint-catalog-20260811";
const BASE_COMMIT = "d5b80c57454bd3759d8fc996120ffab6734062ee";
const PRODUCT_COMMIT = "fcfc92419021dae5f77baad731c634b10c275c5b";
const MARKER = "[run-social-3a0p-linux-gate]";
const RUN_MARKER_PREFIX = "ia4tube-social-3a0p-linux-";
const EVIDENCE_FILE = "social-3a0p-linux-physical-gates-evidence.json";
const EVIDENCE_HASH_FILE = "social-3a0p-linux-physical-gates-evidence.sha256";
const GATE_PROCESS_STATUS_FILE = "social-3a0p-linux-gate-process-status.json";
const GATE_PROCESS_STATUS_HASH_FILE = "social-3a0p-linux-gate-process-status.sha256";
const SANITIZED_MARKER = ".sanitized-approved";
const LEGACY_2A_COMMIT = "9deb1e04249026a7046d44d6cbf4e2da87b9a0a4";
const PHYSICAL_POOL_DRAIN_TIMEOUT_MS = 10_000;
const LOGICAL_DATABASE_PORT = 5432;
const SAFE_FAILURE = /^[a-z][a-z0-9_]{2,119}$/;
const GATE3_PROVENANCE_KEYS = Object.freeze([
  "causalCode",
  "exitCode",
  "externalProcessStarted",
  "lastCompletedSubstep",
  "operation",
  "operationClass",
  "signal",
  "substep"
].sort());
const GATE3_SUBSTEP_DEFINITIONS = Object.freeze({
  B1: Object.freeze({ operation: "base", operationClass: "internal_setup" }),
  B2: Object.freeze({ operation: "base", operationClass: "postgres_transaction" }),
  B3: Object.freeze({ operation: "base", operationClass: "internal_setup" }),
  B4: Object.freeze({ operation: "base", operationClass: "postgres_transaction" }),
  B5: Object.freeze({ operation: "base", operationClass: "postgres_transaction" }),
  B6: Object.freeze({ operation: "base", operationClass: "postgres_concurrent_transactions" }),
  B7: Object.freeze({ operation: "base", operationClass: "internal_validation" }),
  B8: Object.freeze({ operation: "base", operationClass: "postgres_transaction" }),
  B9: Object.freeze({ operation: "base", operationClass: "postgres_transaction" }),
  B10: Object.freeze({ operation: "base", operationClass: "internal_validation" }),
  S1: Object.freeze({ operation: "supplemental", operationClass: "internal_setup" }),
  S2: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S3: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S4: Object.freeze({ operation: "supplemental", operationClass: "internal_setup" }),
  S5: Object.freeze({ operation: "supplemental", operationClass: "postgres_concurrent_transactions" }),
  S6: Object.freeze({ operation: "supplemental", operationClass: "internal_validation" }),
  S7: Object.freeze({ operation: "supplemental", operationClass: "postgres_inventory" }),
  S8: Object.freeze({ operation: "supplemental", operationClass: "internal_setup" }),
  S9: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S10: Object.freeze({ operation: "supplemental", operationClass: "postgres_concurrent_transactions" }),
  S11: Object.freeze({ operation: "supplemental", operationClass: "internal_validation" }),
  S12: Object.freeze({ operation: "supplemental", operationClass: "postgres_concurrent_transactions" }),
  S13: Object.freeze({ operation: "supplemental", operationClass: "internal_setup" }),
  S14: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S15: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S16: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S17: Object.freeze({ operation: "supplemental", operationClass: "postgres_inventory" }),
  S18: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S19: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S20: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S21: Object.freeze({ operation: "supplemental", operationClass: "internal_setup" }),
  S22: Object.freeze({ operation: "supplemental", operationClass: "postgres_concurrent_transactions" }),
  S23: Object.freeze({ operation: "supplemental", operationClass: "internal_validation" }),
  S24: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S25: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S26: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S27: Object.freeze({ operation: "supplemental", operationClass: "postgres_transaction" }),
  S28: Object.freeze({ operation: "supplemental", operationClass: "postgres_inventory" }),
  S29: Object.freeze({ operation: "supplemental", operationClass: "internal_validation" }),
  S30: Object.freeze({ operation: "supplemental", operationClass: "memory_cleanup" })
});
const GATE3_SUBSTEP_ORDER = Object.freeze(Object.keys(GATE3_SUBSTEP_DEFINITIONS));
const GATE3_SUBSTEP_INDEX = new Map(
  GATE3_SUBSTEP_ORDER.map((substep, index) => [substep, index])
);
const GATE4_PROVENANCE_KEYS = Object.freeze([
  "causalCode",
  "exitCode",
  "externalProcessStarted",
  "lastCompletedSubstep",
  "operation",
  "operationClass",
  "signal",
  "substep"
].sort());
const GATE4_SUBSTEP_DEFINITIONS = Object.freeze({
  V01: Object.freeze({ operation: "base", operationClass: "memory_setup" }),
  V02: Object.freeze({ operation: "base", operationClass: "memory_crypto" }),
  V03: Object.freeze({ operation: "base", operationClass: "memory_crypto" }),
  V04: Object.freeze({ operation: "base", operationClass: "memory_validation" }),
  V05: Object.freeze({ operation: "base", operationClass: "memory_validation" }),
  V06: Object.freeze({ operation: "base", operationClass: "memory_crypto" }),
  V07: Object.freeze({ operation: "base", operationClass: "memory_crypto" }),
  V08: Object.freeze({ operation: "base", operationClass: "memory_validation" }),
  V09: Object.freeze({ operation: "base", operationClass: "memory_cleanup" }),
  V10: Object.freeze({ operation: "supplemental", operationClass: "memory_setup" }),
  V11: Object.freeze({ operation: "supplemental", operationClass: "memory_crypto" }),
  V12: Object.freeze({ operation: "supplemental", operationClass: "memory_crypto" }),
  V13: Object.freeze({ operation: "supplemental", operationClass: "memory_validation" }),
  V14: Object.freeze({ operation: "supplemental", operationClass: "memory_validation" }),
  V15: Object.freeze({ operation: "supplemental", operationClass: "memory_validation" }),
  V16: Object.freeze({ operation: "supplemental", operationClass: "memory_validation" }),
  V17: Object.freeze({ operation: "supplemental", operationClass: "memory_validation" }),
  V18: Object.freeze({ operation: "supplemental", operationClass: "memory_validation" }),
  V19: Object.freeze({ operation: "supplemental", operationClass: "memory_cleanup" }),
  V20: Object.freeze({ operation: "persisted", operationClass: "memory_setup" }),
  V21: Object.freeze({ operation: "persisted", operationClass: "postgres_verifier_setup" }),
  V22: Object.freeze({ operation: "persisted", operationClass: "postgres_runtime_isolation" }),
  V23: Object.freeze({ operation: "persisted", operationClass: "postgres_vault_verification" }),
  V24: Object.freeze({ operation: "persisted", operationClass: "postgres_verifier_cleanup" }),
  V25: Object.freeze({ operation: "persisted", operationClass: "memory_cleanup" })
});
const GATE4_SUBSTEP_ORDER = Object.freeze(Object.keys(GATE4_SUBSTEP_DEFINITIONS));
const GATE4_SUBSTEP_INDEX = new Map(
  GATE4_SUBSTEP_ORDER.map((substep, index) => [substep, index])
);
const GATE4_CLEANUP_SUBSTEPS = new Set(["V09", "V19", "V24", "V25"]);
const GATE4_CONNECTION_CAPACITY_DIAGNOSTIC_KEYS = Object.freeze([
  "capturedAtSubstep",
  "classification",
  "database",
  "pools",
  "roles",
  "server",
  "sqlstate",
  "version"
].sort());
const GATE4_CONNECTION_CAPACITY_RAW_KEYS = Object.freeze([
  "database", "pools", "roles", "server"
].sort());
const GATE4_CONNECTION_CAPACITY_SERVER_KEYS = Object.freeze([
  "clientConnectionsBeforeV22Failure",
  "maxConnections",
  "reservedConnections",
  "superuserReservedConnections"
].sort());
const GATE4_CONNECTION_CAPACITY_LIMIT_KEYS = Object.freeze([
  "clientConnectionsBeforeV22Failure", "connectionLimit"
].sort());
const GATE4_CONNECTION_CAPACITY_ROLE_KEYS = Object.freeze([
  "migration", "provisioner", "runtime"
].sort());
const GATE4_CONNECTION_CAPACITY_POOL_NAMES = Object.freeze([
  "mainMigration", "mainRuntime", "verifierMigration", "verifierRuntime"
].sort());
const GATE4_CONNECTION_CAPACITY_POOL_KEYS = Object.freeze([
  "configuredMax",
  "connectAttempts",
  "connectSucceeded",
  "connectionCapacityFailures",
  "idleCount",
  "totalCount",
  "waitingCount"
].sort());
const GATE4_CONNECTION_CAPACITY_CLASSIFICATIONS = new Set([
  "server_connection_slots_reached",
  "database_connection_limit_reached",
  "runtime_role_connection_limit_reached",
  "migration_role_connection_limit_reached",
  "multiple_connection_limits_reached",
  "verifier_pool_capacity_collision",
  "capacity_snapshot_inconclusive"
]);
const GATE3_NODE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT"
]);
const GATE4_NODE_ERROR_CODES = new Set(GATE3_NODE_ERROR_CODES);
const GATE_PROCESS_SIGNALS = new Set([
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT",
  "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2",
  "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD", "SIGCONT",
  "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU",
  "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR",
  "SIGSYS"
]);
const GATE_PROCESS_STATUS_KEYS = Object.freeze([
  "exitCode", "signal", "stderrStored", "stdoutStored", "timedOut"
].sort());
const BACKUP_RESTORE_PROVENANCE_KEYS = Object.freeze([
  "boundary",
  "causalCode",
  "externalTransportProcessStarted",
  "operation",
  "substep",
  "substepExact"
].sort());
const BACKUP_RESTORE_OPERATIONS = new Set([
  "rollback_backup_0003",
  "rollback_restore_0003",
  "gate5_backup_0003",
  "gate5_backup_0004",
  "gate5_restore_0003",
  "gate5_restore_0004",
  "unknown"
]);
const BACKUP_PROVENANCE_OPERATIONS = new Set([
  "rollback_backup_0003",
  "gate5_backup_0003",
  "gate5_backup_0004"
]);
const RESTORE_PROVENANCE_OPERATIONS = new Set([
  "rollback_restore_0003",
  "gate5_restore_0003",
  "gate5_restore_0004"
]);
const BACKUP_RESTORE_BOUNDARIES = new Set([
  "external_process",
  "internal_callback",
  "internal_interval",
  "pre_execution_validation",
  "instrumentation"
]);
const BACKUP_EXTERNAL_SUBSTEPS = Object.freeze([
  "backup_data_snapshot",
  "backup_schema_archive",
  "backup_schema_inventory"
]);
const RESTORE_EXTERNAL_SUBSTEPS = Object.freeze([
  "restore_schema_inventory",
  "restore_schema_apply",
  "restore_data_apply",
  "restore_evidence_capture"
]);
const BACKUP_INTERNAL_INTERVALS = Object.freeze([
  "backup_before_data_snapshot",
  "backup_after_data_snapshot",
  "backup_after_schema_archive",
  "backup_after_schema_inventory"
]);
const RESTORE_INTERNAL_INTERVALS = Object.freeze([
  "restore_before_schema_inventory",
  "restore_after_schema_inventory",
  "restore_after_schema_apply",
  "restore_after_data_apply",
  "restore_after_evidence_capture"
]);
const BACKUP_RESTORE_INTERNAL_CALLBACKS = new Set([
  "backup_lock_acquire",
  "backup_preflight",
  "backup_policy_before_snapshot",
  "backup_policy_after_snapshot",
  "backup_catalog_evidence",
  "backup_lock_release",
  "restore_lock_acquire",
  "restore_target_preflight",
  "restore_policy_before_apply",
  "restore_policy_after_data",
  "restore_catalog_evidence",
  "restore_runtime_isolation",
  "restore_vault",
  "restore_2a_compatibility",
  "restore_profile_validation",
  "restore_verifier_cleanup",
  "restore_lock_release"
]);
const BACKUP_RESTORE_SUBSTEPS = new Set([
  ...BACKUP_EXTERNAL_SUBSTEPS,
  ...RESTORE_EXTERNAL_SUBSTEPS,
  ...BACKUP_INTERNAL_INTERVALS,
  ...RESTORE_INTERNAL_INTERVALS,
  ...BACKUP_RESTORE_INTERNAL_CALLBACKS,
  "unknown"
]);
const SAFE_PHASE = new Set([
  "platform", "durability", "postgres", "bootstrap", "migrations",
  "rls_privilege_inventory_context_reproduction",
  "rls_runtime_write_contract_reproduction",
  "rls_runtime_attributes_text_resolution_reproduction", "rls_roles",
  "concurrency_oauth_idempotency", "vault", "backup_restore", "metrics", "secret_scan", "cleanup"
]);
const RLS_SUBSTEPS = new Set([
  "rls_base_gate",
  "rls_seed_tenants",
  "rls_privilege_inventory",
  "rls_inventory_direct_session_identity",
  "rls_inventory_direct_schema_access",
  "rls_inventory_direct_name_resolution_refusal",
  "rls_inventory_migrator_role_activation",
  "rls_inventory_migrator_privilege_read",
  "rls_inventory_role_reset",
  "rls_core_user_insert_reproduction",
  "rls_core_user_insert_refusal",
  "rls_runtime_attributes_direct_identity",
  "rls_runtime_attributes_text_resolution_refusal",
  "rls_runtime_attributes_oid_catalog",
  "rls_runtime_attributes_oid_privileges",
  "rls_runtime_attributes_acl_reset",
  "rls_runtime_attributes_evidence_validation",
  "rls_bidirectional_read",
  "rls_missing_context",
  "rls_tampered_context",
  "rls_own_social_write",
  "rls_cross_tenant_write",
  "rls_connection_scope_reset",
  "rls_runtime_role_attributes"
]);
const RLS_INVENTORY_CONTEXT_REPRODUCTION_RESULT = Object.freeze({
  aclUnchanged: true,
  directLoginBypassRls: false,
  directLoginCanSetMigratorRole: true,
  directLoginCreateRole: false,
  directLoginInheritsMigratorRole: false,
  directLoginSuperuser: false,
  directNameResolutionRefused: true,
  directPoolUsableAfterRefusal: true,
  directSchemaUsage: false,
  directSessionIdentityVerified: true,
  directTransactionPersisted: false,
  inventoryCurrentUserMigrator: true,
  inventorySessionUserMigration: true,
  migratorInventorySucceeded: true,
  migratorRoleActivated: true,
  migratorSchemaUsage: false,
  migratorSessionIdentityPreserved: true,
  oidInventoryUsed: true,
  privilegesUnchanged: true,
  relationCount: 2,
  textualRelationResolutionUsed: false,
  roleResetAfterTransaction: true
});
const RLS_BASE_GATE_RESULT = Object.freeze({
  forceRls: true,
  missingContextRefused: true,
  physicalExecution: true,
  syntheticCompanies: 2,
  syntheticOnly: true,
  tamperedContextRefused: true,
  tenantIsolation: true
});
const RLS_REPRODUCTION_RESULT = Object.freeze({
  oldGateLaterStagesReached: false,
  runtimeCoreUserInsertPersisted: false,
  runtimeCoreUserInsertPrivilege: false,
  runtimeCoreUserInsertRefused: true,
  runtimePoolUsableAfterRefusal: true,
  runtimePrivilegesUnchanged: true,
  runtimeWriteContractReproductionPassed: true,
  socialAuditEventInsertPrivilege: true,
  socialAuditEventsRlsProtected: true,
  tenantSeedsCreatedByAdministrativeRole: true
});
const RLS_REPRODUCTION_EVIDENCE = Object.freeze({
  baseRlsGatePassed: true,
  oldGateLaterStagesReached: false,
  runtimeCoreUserInsertPersisted: false,
  runtimeCoreUserInsertPrivilege: false,
  runtimeCoreUserInsertRefused: true,
  runtimePoolUsableAfterRefusal: true,
  runtimePrivilegesUnchanged: true,
  socialAuditEventInsertPrivilege: true,
  socialAuditEventsRlsProtected: true,
  tenantSeedsCreatedByAdministrativeRole: true
});
const RLS_RUNTIME_ATTRIBUTES_TEXT_RESOLUTION_RESULT = Object.freeze({
  runtimeLoginAttributesSafe: true,
  runtimeRoleAttributesSafe: true,
  runtimeLoginMigratorMember: false,
  runtimeRoleMigratorMember: false,
  runtimeLoginOwnerMember: false,
  runtimeRoleOwnerMember: false,
  runtimeLoginMigrationSchemaUsage: false,
  runtimeRoleMigrationSchemaUsage: false,
  runtimeLoginMigrationSchemaCreate: false,
  runtimeRoleMigrationSchemaCreate: false,
  runtimeLoginMigrationTablePrivileges: false,
  runtimeRoleMigrationTablePrivileges: false,
  migrationSchemaLocatedByOid: true,
  migrationLedgerLocatedByOid: true,
  textualResolutionUsed: false,
  aclUnchanged: true
});
const RLS_ROLE_GATE_RESULT = Object.freeze({
  baseRlsGatePassed: true,
  companyAOwnRead: true,
  companyAOwnSocialWrite: true,
  companyAToBReadRefused: true,
  companyAToBWriteRefused: true,
  companyBOwnRead: true,
  companyBOwnSocialWrite: true,
  companyBToAReadRefused: true,
  companyBToAWriteRefused: true,
  connectionScopeReset: true,
  crossTenantRowsPersisted: false,
  missingContextZeroRows: true,
  runtimeBypassRls: false,
  runtimeCoreUserInsertPersisted: false,
  runtimeCoreUserInsertPrivilege: false,
  runtimeCoreUserInsertRefused: true,
  runtimeCreateDb: false,
  runtimeCreateRole: false,
  runtimeMigrationPrivileges: false,
  runtimeSuperuser: false,
  tamperedContextRefused: true,
  tenantSeedsCreatedByAdministrativeRole: true
});
const LINUX_RESTORE_DATABASE =
  /^ia4tube_social_disposable_(?:rollback_0003|restore_0003|restore_0004|tamper|cross)_[0-9a-f]{12}$/;
const LINUX_VERIFIER_DATABASE =
  /^ia4tube_social_disposable_(?:rollback_source|rollback_0003|source_0003|restore_0003|restore_0004|tamper|cross)_[0-9a-f]{12}$/;
const LOGIN_VERIFIER_SESSION_OPTIONS =
  "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=5000";
const LOGIN_VERIFIER_AMBIENT_URL_NAMES = new Set([
  "DATABASE_URL", "POSTGRESQL_URL", "POSTGRES_URL"
]);
const LOGIN_VERIFIER_POOL_KEYS = Object.freeze([
  "allowExitOnIdle", "application_name", "connectionString", "connectionTimeoutMillis",
  "database", "host", "idleTimeoutMillis", "max", "min", "options", "password",
  "port", "query_timeout", "ssl", "user"
].sort());
const RESTORE_APPLICATION_SCHEMAS = Object.freeze([
  "ia4tube_social",
  "ia4tube_social_admin",
  "ia4tube_migrations"
]);
const SCHEMA_PROFILE_0003 = "social-schema-0003";
const SCHEMA_PROFILE_0004 = "social-schema-0004";
const SCHEMA_PROFILE_IDS = Object.freeze([
  SCHEMA_PROFILE_0003,
  SCHEMA_PROFILE_0004
]);
const SCHEMA_PROFILE_DIAGNOSTIC_KEYS = Object.freeze([
  "expectedRelationCount",
  "kindMismatchCount",
  "missingRelationCount",
  "observedRelationCount",
  "ownerMismatchCount",
  "unexpectedRelationCount"
].sort());

class LinuxGateFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "LinuxGateFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new LinuxGateFailure(code);
}

function failureCode(error) {
  const candidate = String(error?.code || error?.message || "");
  return SAFE_FAILURE.test(candidate) ? candidate : "linux_gate_unclassified_failure";
}

function gate3CodeFromCandidate(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return "gate3_error_code_unavailable";
  }
  if (SAFE_FAILURE.test(candidate)) return candidate;
  if (GATE3_NODE_ERROR_CODES.has(candidate)) {
    return `gate3_error_code_${candidate.toLowerCase()}`;
  }
  if (/^[0-9A-Za-z]{5}$/.test(candidate)) {
    return `gate3_error_code_${candidate.toLowerCase()}`;
  }
  return "gate3_error_code_unsupported";
}

function gate3FailureCode(error) {
  const candidate = typeof error?.code === "string" ? error.code : "";
  if (candidate === "postgres_rollback_failed") {
    if (typeof error?.cause?.code === "string") {
      return gate3CodeFromCandidate(error.cause.code);
    }
    return "postgres_rollback_failed";
  }
  if (candidate.length > 0) return gate3CodeFromCandidate(candidate);
  if (error instanceof TypeError) return "gate3_type_error";
  return "gate3_error_code_unavailable";
}

function sanitizedGate3FailureProvenance(candidate) {
  if (candidate == null) return null;
  if (
    !candidate || Object.getPrototypeOf(candidate) !== Object.prototype ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(GATE3_PROVENANCE_KEYS)
  ) return null;
  const definition = GATE3_SUBSTEP_DEFINITIONS[candidate.substep];
  const lastCompletedDefinition = candidate.lastCompletedSubstep == null
    ? null
    : GATE3_SUBSTEP_DEFINITIONS[candidate.lastCompletedSubstep];
  if (
    !definition ||
    candidate.operation !== definition.operation ||
    candidate.operationClass !== definition.operationClass ||
    !SAFE_FAILURE.test(String(candidate.causalCode || "")) ||
    candidate.externalProcessStarted !== false ||
    candidate.exitCode !== null ||
    candidate.signal !== null ||
    (candidate.lastCompletedSubstep !== null && (
      !lastCompletedDefinition ||
      GATE3_SUBSTEP_INDEX.get(candidate.lastCompletedSubstep) >=
        GATE3_SUBSTEP_INDEX.get(candidate.substep)
    ))
  ) return null;
  return Object.freeze({
    operation: candidate.operation,
    substep: candidate.substep,
    operationClass: candidate.operationClass,
    causalCode: candidate.causalCode,
    lastCompletedSubstep: candidate.lastCompletedSubstep,
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  });
}

function createGate3FailureProvenanceTracker() {
  let firstFailure = null;
  let lastCompletedSubstep = null;

  async function runSubstep(operation, substep, operationClass, execute) {
    const definition = GATE3_SUBSTEP_DEFINITIONS[substep];
    if (
      !definition || definition.operation !== operation ||
      definition.operationClass !== operationClass ||
      typeof execute !== "function"
    ) {
      fail("gate3_failure_provenance_substep_invalid");
    }
    try {
      const result = await execute();
      if (!firstFailure) lastCompletedSubstep = substep;
      return result;
    } catch (error) {
      if (!firstFailure) {
        firstFailure = Object.freeze({
          operation,
          substep,
          operationClass,
          causalCode: gate3FailureCode(error),
          lastCompletedSubstep,
          externalProcessStarted: false,
          exitCode: null,
          signal: null
        });
      }
      throw error;
    }
  }

  function forOperation(operation) {
    if (!new Set(["base", "supplemental"]).has(operation)) {
      fail("gate3_failure_provenance_operation_invalid");
    }
    return async function runGate3Substep(substep, operationClass, execute) {
      return runSubstep(operation, substep, operationClass, execute);
    };
  }

  return Object.freeze({
    failure() { return firstFailure; },
    forOperation,
    runSubstep
  });
}

function gate4CodeFromCandidate(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return "gate4_error_code_unavailable";
  }
  if (SAFE_FAILURE.test(candidate)) return candidate;
  if (
    GATE4_NODE_ERROR_CODES.has(candidate) ||
    /^[0-9A-Za-z]{5}$/.test(candidate)
  ) {
    return `gate4_error_code_${candidate.toLowerCase()}`;
  }
  return "gate4_error_code_unavailable";
}

function gate4FailureCode(error) {
  const candidate = typeof error?.code === "string" ? error.code : "";
  if (candidate === "postgres_rollback_failed") {
    if (typeof error?.cause?.code === "string") {
      return gate4CodeFromCandidate(error.cause.code);
    }
    return "postgres_rollback_failed";
  }
  if (candidate.length > 0) return gate4CodeFromCandidate(candidate);
  if (error instanceof TypeError) return "gate4_type_error";
  if (error instanceof RangeError) return "gate4_range_error";
  return "gate4_error_code_unavailable";
}

function sanitizedGate4FailureProvenance(candidate) {
  if (candidate == null) return null;
  const descriptors = candidate && Object.getPrototypeOf(candidate) === Object.prototype
    ? Object.getOwnPropertyDescriptors(candidate)
    : null;
  if (
    !candidate || Object.getPrototypeOf(candidate) !== Object.prototype ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(GATE4_PROVENANCE_KEYS) ||
    !Object.values(descriptors).every((descriptor) => (
      Object.hasOwn(descriptor, "value") && descriptor.enumerable === true
    ))
  ) return null;
  const definition = GATE4_SUBSTEP_DEFINITIONS[candidate.substep];
  const substepIndex = GATE4_SUBSTEP_INDEX.get(candidate.substep);
  const expectedLastCompletedSubstep = substepIndex === 0
    ? null
    : GATE4_SUBSTEP_ORDER[substepIndex - 1];
  if (
    !definition ||
    candidate.operation !== definition.operation ||
    candidate.operationClass !== definition.operationClass ||
    typeof candidate.causalCode !== "string" ||
    !SAFE_FAILURE.test(candidate.causalCode) ||
    candidate.externalProcessStarted !== false ||
    candidate.exitCode !== null ||
    candidate.signal !== null ||
    candidate.lastCompletedSubstep !== expectedLastCompletedSubstep
  ) return null;
  return Object.freeze({
    operation: candidate.operation,
    substep: candidate.substep,
    operationClass: candidate.operationClass,
    causalCode: candidate.causalCode,
    lastCompletedSubstep: candidate.lastCompletedSubstep,
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  });
}

function gate4CapacityDataValues(candidate, keys) {
  try {
    if (!candidate || Object.getPrototypeOf(candidate) !== Object.prototype) return null;
    if (Object.getOwnPropertySymbols(candidate).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const names = Object.keys(descriptors).sort();
    if (
      names.length !== keys.length ||
      names.some((name, index) => name !== keys[index])
    ) return null;
    const values = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        !descriptor || !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) return null;
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    return null;
  }
}

function gate4CapacityPool(candidate) {
  const values = gate4CapacityDataValues(
    candidate,
    GATE4_CONNECTION_CAPACITY_POOL_KEYS
  );
  if (!values) return null;
  for (const key of GATE4_CONNECTION_CAPACITY_POOL_KEYS) {
    if (
      !Number.isSafeInteger(values[key]) ||
      (key === "configuredMax" ? values[key] <= 0 : values[key] < 0)
    ) return null;
  }
  if (
    values.idleCount > values.totalCount ||
    values.totalCount > values.configuredMax ||
    values.connectSucceeded > values.connectAttempts ||
    values.connectionCapacityFailures >
      values.connectAttempts - values.connectSucceeded
  ) return null;
  return Object.freeze({
    configuredMax: values.configuredMax,
    totalCount: values.totalCount,
    idleCount: values.idleCount,
    waitingCount: values.waitingCount,
    connectAttempts: values.connectAttempts,
    connectSucceeded: values.connectSucceeded,
    connectionCapacityFailures: values.connectionCapacityFailures
  });
}

function gate4CapacityPools(candidate) {
  const values = gate4CapacityDataValues(
    candidate,
    GATE4_CONNECTION_CAPACITY_POOL_NAMES
  );
  if (!values) return null;
  const mainMigration = gate4CapacityPool(values.mainMigration);
  const mainRuntime = gate4CapacityPool(values.mainRuntime);
  const verifierMigration = gate4CapacityPool(values.verifierMigration);
  const verifierRuntime = gate4CapacityPool(values.verifierRuntime);
  if (!mainMigration || !mainRuntime || !verifierMigration || !verifierRuntime) {
    return null;
  }
  return Object.freeze({
    mainMigration,
    mainRuntime,
    verifierMigration,
    verifierRuntime
  });
}

function unavailableGate4CapacitySnapshot() {
  const unavailableLimit = () => Object.freeze({
    connectionLimit: null,
    clientConnectionsBeforeV22Failure: null
  });
  return Object.freeze({
    available: false,
    server: Object.freeze({
      maxConnections: null,
      reservedConnections: null,
      superuserReservedConnections: null,
      clientConnectionsBeforeV22Failure: null
    }),
    database: unavailableLimit(),
    roles: Object.freeze({
      provisioner: unavailableLimit(),
      migration: unavailableLimit(),
      runtime: unavailableLimit()
    })
  });
}

function gate4CapacitySnapshot(serverCandidate, databaseCandidate, rolesCandidate) {
  const server = gate4CapacityDataValues(
    serverCandidate,
    GATE4_CONNECTION_CAPACITY_SERVER_KEYS
  );
  const database = gate4CapacityDataValues(
    databaseCandidate,
    GATE4_CONNECTION_CAPACITY_LIMIT_KEYS
  );
  const roles = gate4CapacityDataValues(
    rolesCandidate,
    GATE4_CONNECTION_CAPACITY_ROLE_KEYS
  );
  if (!server || !database || !roles) return null;
  const provisioner = gate4CapacityDataValues(
    roles.provisioner,
    GATE4_CONNECTION_CAPACITY_LIMIT_KEYS
  );
  const migration = gate4CapacityDataValues(
    roles.migration,
    GATE4_CONNECTION_CAPACITY_LIMIT_KEYS
  );
  const runtime = gate4CapacityDataValues(
    roles.runtime,
    GATE4_CONNECTION_CAPACITY_LIMIT_KEYS
  );
  if (!provisioner || !migration || !runtime) return null;
  const allValues = [
    server.maxConnections,
    server.reservedConnections,
    server.superuserReservedConnections,
    server.clientConnectionsBeforeV22Failure,
    database.connectionLimit,
    database.clientConnectionsBeforeV22Failure,
    provisioner.connectionLimit,
    provisioner.clientConnectionsBeforeV22Failure,
    migration.connectionLimit,
    migration.clientConnectionsBeforeV22Failure,
    runtime.connectionLimit,
    runtime.clientConnectionsBeforeV22Failure
  ];
  if (allValues.every((value) => value === null)) {
    return unavailableGate4CapacitySnapshot();
  }
  if (allValues.some((value) => value === null)) return null;
  if (
    !Number.isSafeInteger(server.maxConnections) || server.maxConnections <= 0 ||
    !Number.isSafeInteger(server.reservedConnections) || server.reservedConnections < 0 ||
    !Number.isSafeInteger(server.superuserReservedConnections) ||
      server.superuserReservedConnections < 0 ||
    server.reservedConnections + server.superuserReservedConnections >=
      server.maxConnections ||
    !Number.isSafeInteger(server.clientConnectionsBeforeV22Failure) ||
      server.clientConnectionsBeforeV22Failure < 0
  ) return null;
  for (const item of [database, provisioner, migration, runtime]) {
    if (
      !Number.isSafeInteger(item.connectionLimit) ||
      !(item.connectionLimit === -1 || item.connectionLimit >= 0) ||
      !Number.isSafeInteger(item.clientConnectionsBeforeV22Failure) ||
      item.clientConnectionsBeforeV22Failure < 0
    ) return null;
  }
  const limit = (item) => Object.freeze({
    connectionLimit: item.connectionLimit,
    clientConnectionsBeforeV22Failure: item.clientConnectionsBeforeV22Failure
  });
  return Object.freeze({
    available: true,
    server: Object.freeze({
      maxConnections: server.maxConnections,
      reservedConnections: server.reservedConnections,
      superuserReservedConnections: server.superuserReservedConnections,
      clientConnectionsBeforeV22Failure: server.clientConnectionsBeforeV22Failure
    }),
    database: limit(database),
    roles: Object.freeze({
      provisioner: limit(provisioner),
      migration: limit(migration),
      runtime: limit(runtime)
    })
  });
}

function normalizedGate4ConnectionCapacityRaw(candidate) {
  const values = gate4CapacityDataValues(
    candidate,
    GATE4_CONNECTION_CAPACITY_RAW_KEYS
  );
  if (!values) return null;
  const pools = gate4CapacityPools(values.pools);
  const snapshot = gate4CapacitySnapshot(
    values.server,
    values.database,
    values.roles
  );
  if (!pools || !snapshot) return null;
  return Object.freeze({ pools, snapshot });
}

function gate4CapacityCategoryFailures(pools) {
  return Object.freeze({
    migration:
      pools.mainMigration.connectionCapacityFailures > 0 ||
      pools.verifierMigration.connectionCapacityFailures > 0,
    runtime:
      pools.mainRuntime.connectionCapacityFailures > 0 ||
      pools.verifierRuntime.connectionCapacityFailures > 0
  });
}

function gate4VerifierPoolCollision(main, verifier) {
  return verifier.connectionCapacityFailures > 0 &&
    verifier.connectAttempts > verifier.connectSucceeded &&
    main.totalCount > 0 && verifier.totalCount > 0;
}

function classifyNormalizedGate4ConnectionCapacity(normalized) {
  if (!normalized?.snapshot?.available) return "capacity_snapshot_inconclusive";
  const { snapshot, pools } = normalized;
  const failures = gate4CapacityCategoryFailures(pools);
  const failedCategoryDetermined = failures.migration !== failures.runtime;
  const anyCapacityFailure = failures.migration || failures.runtime;
  const serverLimitObserved =
    snapshot.server.clientConnectionsBeforeV22Failure >=
      snapshot.server.maxConnections;
  const databaseLimitObserved =
    snapshot.database.connectionLimit >= 0 &&
    snapshot.database.clientConnectionsBeforeV22Failure >=
      snapshot.database.connectionLimit;
  const runtimeLimitObserved =
    snapshot.roles.runtime.connectionLimit >= 0 &&
    snapshot.roles.runtime.clientConnectionsBeforeV22Failure >=
      snapshot.roles.runtime.connectionLimit;
  const serverReached = failedCategoryDetermined && serverLimitObserved;
  const databaseReached = anyCapacityFailure && databaseLimitObserved;
  const runtimeReached = failures.runtime && runtimeLimitObserved;
  const migrationSqlCounterReached = failures.migration &&
    snapshot.roles.migration.connectionLimit >= 0 &&
    snapshot.roles.migration.clientConnectionsBeforeV22Failure >=
      snapshot.roles.migration.connectionLimit;
  const migrationHarnessCapacityReached =
    pools.mainMigration.configuredMax === 2 &&
    snapshot.roles.migration.connectionLimit >= 0 &&
    pools.mainMigration.totalCount >= snapshot.roles.migration.connectionLimit &&
    pools.mainMigration.idleCount === pools.mainMigration.totalCount &&
    pools.mainMigration.waitingCount === 0 &&
    pools.verifierMigration.connectionCapacityFailures > 0 &&
    pools.verifierMigration.connectSucceeded === 0 &&
    !serverLimitObserved && !databaseLimitObserved && !runtimeLimitObserved;
  const migrationReached = migrationSqlCounterReached || migrationHarnessCapacityReached;
  const reached = [
    [serverReached, "server_connection_slots_reached"],
    [databaseReached, "database_connection_limit_reached"],
    [runtimeReached, "runtime_role_connection_limit_reached"],
    [migrationReached, "migration_role_connection_limit_reached"]
  ].filter(([condition]) => condition);
  if (reached.length > 1) return "multiple_connection_limits_reached";
  if (reached.length === 1) {
    const classification = reached[0][1];
    if (
      !failedCategoryDetermined &&
      (
        classification === "runtime_role_connection_limit_reached" ||
        classification === "migration_role_connection_limit_reached"
      )
    ) return "capacity_snapshot_inconclusive";
    return classification;
  }
  const migrationCollision = gate4VerifierPoolCollision(
    pools.mainMigration,
    pools.verifierMigration
  );
  const runtimeCollision = gate4VerifierPoolCollision(
    pools.mainRuntime,
    pools.verifierRuntime
  );
  if (
    failures.migration !== failures.runtime &&
    migrationCollision !== runtimeCollision &&
    (migrationCollision || runtimeCollision)
  ) return "verifier_pool_capacity_collision";
  return "capacity_snapshot_inconclusive";
}

function classifyGate4ConnectionCapacityDiagnostics(candidate) {
  try {
    const normalized = normalizedGate4ConnectionCapacityRaw(candidate);
    return normalized
      ? classifyNormalizedGate4ConnectionCapacity(normalized)
      : "capacity_snapshot_inconclusive";
  } catch {
    return "capacity_snapshot_inconclusive";
  }
}

function gate4ConnectionCapacityDiagnosticFromNormalized(normalized, classification) {
  return Object.freeze({
    version: 1,
    capturedAtSubstep: "V22",
    sqlstate: "53300",
    server: normalized.snapshot.server,
    database: normalized.snapshot.database,
    roles: normalized.snapshot.roles,
    pools: normalized.pools,
    classification
  });
}

function createGate4ConnectionCapacityDiagnostics(candidate) {
  try {
    const normalized = normalizedGate4ConnectionCapacityRaw(candidate);
    if (!normalized) return null;
    return gate4ConnectionCapacityDiagnosticFromNormalized(
      normalized,
      classifyNormalizedGate4ConnectionCapacity(normalized)
    );
  } catch {
    return null;
  }
}

function sanitizedGate4ConnectionCapacityDiagnostics(candidate) {
  try {
    if (candidate == null) return null;
    const values = gate4CapacityDataValues(
      candidate,
      GATE4_CONNECTION_CAPACITY_DIAGNOSTIC_KEYS
    );
    if (
      !values || values.version !== 1 ||
      values.capturedAtSubstep !== "V22" ||
      values.sqlstate !== "53300" ||
      typeof values.classification !== "string" ||
      !GATE4_CONNECTION_CAPACITY_CLASSIFICATIONS.has(values.classification)
    ) return null;
    const normalized = normalizedGate4ConnectionCapacityRaw({
      server: values.server,
      database: values.database,
      roles: values.roles,
      pools: values.pools
    });
    if (!normalized) return null;
    const classification = classifyNormalizedGate4ConnectionCapacity(normalized);
    if (values.classification !== classification) return null;
    return gate4ConnectionCapacityDiagnosticFromNormalized(
      normalized,
      classification
    );
  } catch {
    return null;
  }
}

function gate4ConnectionCapacityInconclusiveFromCandidate(candidate) {
  try {
    if (!candidate || Object.getPrototypeOf(candidate) !== Object.prototype) return null;
    const descriptor = Object.getOwnPropertyDescriptor(candidate, "pools");
    if (
      !descriptor || !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) return null;
    const pools = gate4CapacityPools(descriptor.value);
    if (!pools) return null;
    return gate4ConnectionCapacityDiagnosticFromNormalized(
      Object.freeze({
        pools,
        snapshot: unavailableGate4CapacitySnapshot()
      }),
      "capacity_snapshot_inconclusive"
    );
  } catch {
    return null;
  }
}

function isGate4ConnectionCapacityFailure(candidate) {
  const provenance = sanitizedGate4FailureProvenance(candidate);
  return provenance !== null &&
    provenance.operation === "persisted" &&
    provenance.substep === "V22" &&
    provenance.operationClass === "postgres_runtime_isolation" &&
    provenance.causalCode === "gate4_error_code_53300" &&
    provenance.lastCompletedSubstep === "V21" &&
    provenance.externalProcessStarted === false &&
    provenance.exitCode === null &&
    provenance.signal === null;
}

function createGate4ConnectionCapacityDiagnosticsRecorder() {
  let attempted = false;
  let diagnostics = null;
  function record(candidate) {
    if (attempted) return false;
    attempted = true;
    diagnostics = createGate4ConnectionCapacityDiagnostics(candidate) ||
      gate4ConnectionCapacityInconclusiveFromCandidate(candidate);
    return diagnostics !== null;
  }
  return Object.freeze({
    attempted() { return attempted; },
    forFailure(provenance) {
      return isGate4ConnectionCapacityFailure(provenance)
        ? diagnostics
        : null;
    },
    record
  });
}

function createGate4FailureProvenanceTracker() {
  let firstFailure = null;
  let lastCompletedSubstep = null;
  let highestObservedIndex = -1;
  let inFlight = false;
  const observedSubsteps = new Set();

  async function runSubstep(operation, substep, operationClass, execute) {
    if (inFlight) fail("gate4_failure_provenance_reentrancy_refused");
    const definition = GATE4_SUBSTEP_DEFINITIONS[substep];
    const index = GATE4_SUBSTEP_INDEX.get(substep);
    let cleanupSequenceValid = false;
    if (firstFailure?.operation === "base") {
      cleanupSequenceValid = substep === "V09" && index > highestObservedIndex;
    } else if (firstFailure?.operation === "supplemental") {
      cleanupSequenceValid = substep === "V19" && index > highestObservedIndex;
    } else if (firstFailure?.operation === "persisted") {
      cleanupSequenceValid = highestObservedIndex < GATE4_SUBSTEP_INDEX.get("V24")
        ? substep === "V24"
        : highestObservedIndex === GATE4_SUBSTEP_INDEX.get("V24") && substep === "V25";
    }
    const sequenceValid = firstFailure
      ? GATE4_CLEANUP_SUBSTEPS.has(substep) && cleanupSequenceValid
      : index === highestObservedIndex + 1;
    if (
      !definition || definition.operation !== operation ||
      definition.operationClass !== operationClass ||
      typeof execute !== "function" ||
      observedSubsteps.has(substep) ||
      !sequenceValid
    ) {
      fail("gate4_failure_provenance_substep_invalid");
    }
    observedSubsteps.add(substep);
    highestObservedIndex = index;
    inFlight = true;
    try {
      const result = await execute();
      if (!firstFailure) lastCompletedSubstep = substep;
      return result;
    } catch (error) {
      if (!firstFailure) {
        firstFailure = Object.freeze({
          operation,
          substep,
          operationClass,
          causalCode: gate4FailureCode(error),
          lastCompletedSubstep,
          externalProcessStarted: false,
          exitCode: null,
          signal: null
        });
      }
      throw error;
    } finally {
      inFlight = false;
    }
  }

  function forOperation(operation) {
    if (!new Set(["base", "supplemental", "persisted"]).has(operation)) {
      fail("gate4_failure_provenance_operation_invalid");
    }
    return async function runGate4Substep(substep, operationClass, execute) {
      return runSubstep(operation, substep, operationClass, execute);
    };
  }

  return Object.freeze({
    failure() { return firstFailure; },
    forOperation,
    requireFailure() {
      if (!firstFailure) fail("gate4_failure_provenance_unobserved");
      return firstFailure;
    },
    requireComplete() {
      if (
        firstFailure !== null ||
        observedSubsteps.size !== GATE4_SUBSTEP_ORDER.length ||
        highestObservedIndex !== GATE4_SUBSTEP_ORDER.length - 1 ||
        lastCompletedSubstep !== "V25"
      ) fail("gate4_failure_provenance_incomplete");
      return true;
    },
    runSubstep
  });
}

function sanitizedGateProcessStatus(candidate) {
  if (
    !candidate || Object.getPrototypeOf(candidate) !== Object.prototype ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(GATE_PROCESS_STATUS_KEYS) ||
    !(candidate.exitCode === null || (
      Number.isSafeInteger(candidate.exitCode) && candidate.exitCode >= 0
    )) ||
    !(candidate.signal === null || GATE_PROCESS_SIGNALS.has(candidate.signal)) ||
    typeof candidate.timedOut !== "boolean" ||
    candidate.stdoutStored !== false ||
    candidate.stderrStored !== false ||
    (candidate.signal !== null && candidate.exitCode !== null) ||
    (candidate.timedOut === true && candidate.exitCode !== null)
  ) return null;
  return Object.freeze({
    exitCode: candidate.exitCode,
    signal: candidate.signal,
    timedOut: candidate.timedOut,
    stdoutStored: false,
    stderrStored: false
  });
}

function gateProcessStatusFromChildResult(candidate = {}) {
  const signal = candidate.signal == null ? null : String(candidate.signal);
  const status = sanitizedGateProcessStatus({
    exitCode: signal || candidate.timedOut === true
      ? null
      : candidate.exitCode,
    signal,
    timedOut: candidate.timedOut === true,
    stdoutStored: false,
    stderrStored: false
  });
  if (!status) fail("linux_gate_process_status_invalid");
  return status;
}

function writeGateProcessStatus(options = {}) {
  const evidenceDirectory = path.resolve(String(options.evidenceDirectory || ""));
  if (!evidenceDirectory) {
    fail("linux_gate_process_status_directory_invalid");
  }
  if (!fs.existsSync(evidenceDirectory)) {
    fs.mkdirSync(evidenceDirectory, { recursive: false, mode: 0o700 });
  }
  if (!fs.statSync(evidenceDirectory).isDirectory()) {
    fail("linux_gate_process_status_directory_invalid");
  }
  const status = sanitizedGateProcessStatus(options.status);
  if (!status) fail("linux_gate_process_status_invalid");
  const serialized = `${canonicalJson(status)}\n`;
  const digest = crypto.createHash("sha256").update(serialized).digest("hex");
  fs.writeFileSync(
    path.join(evidenceDirectory, GATE_PROCESS_STATUS_FILE),
    serialized,
    { flag: "wx", mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(evidenceDirectory, GATE_PROCESS_STATUS_HASH_FILE),
    `${digest}  ${GATE_PROCESS_STATUS_FILE}\n`,
    { flag: "wx", mode: 0o600 }
  );
  return status;
}

async function runGateProcessSupervisor(options = {}) {
  const runnerTemp = path.resolve(options.runnerTemp || process.env.RUNNER_TEMP || "");
  const evidenceDirectory = path.resolve(
    options.evidenceDirectory ||
    process.env.SOCIAL_3A0P_EVIDENCE_DIR ||
    path.join(runnerTemp, "social-3a0p-linux-gate-evidence")
  );
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs === undefined ? 50 * 60_000 : options.timeoutMs;
  const killGraceMs = options.killGraceMs === undefined ? 10_000 : options.killGraceMs;
  if (
    typeof spawnImpl !== "function" ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
    !Number.isSafeInteger(killGraceMs) || killGraceMs < 1
  ) fail("linux_gate_process_supervisor_invalid");

  let child;
  try {
    child = spawnImpl(process.execPath, [__filename, "--run"], {
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
  } catch {
    const status = gateProcessStatusFromChildResult({
      exitCode: null,
      signal: null,
      timedOut: false
    });
    writeGateProcessStatus({ evidenceDirectory, status });
    return Object.freeze({ status, workflowExitCode: 1 });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      try {
        const status = gateProcessStatusFromChildResult({
          exitCode,
          signal,
          timedOut
        });
        writeGateProcessStatus({ evidenceDirectory, status });
        resolve(Object.freeze({
          status,
          workflowExitCode: status.exitCode === 0 && status.timedOut === false ? 0 : 1
        }));
      } catch (error) {
        reject(error);
      }
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* closed status remains fail-closed */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* closed status remains fail-closed */ }
      }, killGraceMs);
    }, timeoutMs);
    child.once("error", () => finish(null, null));
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
  });
}

function closedRlsCauseCode(error, depth = 0) {
  const candidate = String(error?.code || "");
  if (candidate === "42501") return "postgres_insufficient_privilege";
  if (candidate === "22P02") return "postgres_invalid_text_representation";
  if (candidate === "postgres_rollback_failed") {
    if (
      depth >= 4 || !error?.cause ||
      typeof error.cause.code !== "string"
    ) return "postgres_rollback_failed";
    return closedRlsCauseCode(error.cause, depth + 1);
  }
  return SAFE_FAILURE.test(candidate) ? candidate : "postgres_rollback_failed";
}

function rlsFailureCode(error) {
  if (String(error?.code || "") === "postgres_rollback_failed") {
    return closedRlsCauseCode(error);
  }
  const sqlstate = String(error?.code || "");
  if (sqlstate === "42501") return "postgres_insufficient_privilege";
  if (sqlstate === "22P02") return "postgres_invalid_text_representation";
  return failureCode(error);
}

function sanitizedRlsFailureProvenance(candidate) {
  if (candidate == null) return null;
  if (
    !candidate || Object.getPrototypeOf(candidate) !== Object.prototype ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(["causalCode", "substep"]) ||
    !RLS_SUBSTEPS.has(candidate.substep) ||
    !SAFE_FAILURE.test(String(candidate.causalCode || ""))
  ) {
    return null;
  }
  return Object.freeze({
    substep: candidate.substep,
    causalCode: candidate.causalCode
  });
}

function createRlsFailureProvenanceTracker() {
  let firstFailure = null;
  async function runSubstep(substep, operation) {
    if (!RLS_SUBSTEPS.has(substep) || typeof operation !== "function") {
      fail("rls_failure_provenance_substep_invalid");
    }
    try {
      return await operation();
    } catch (error) {
      const causalCode = rlsFailureCode(error);
      if (!firstFailure) {
        firstFailure = Object.freeze({ substep, causalCode });
      }
      throw new LinuxGateFailure(causalCode);
    }
  }
  return Object.freeze({
    runSubstep,
    failure() { return firstFailure; }
  });
}

function exactRlsResult(candidate, expected, code) {
  if (
    !candidate || Object.getPrototypeOf(candidate) !== Object.prototype ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(Object.keys(expected).sort()) ||
    Object.entries(expected).some(([key, value]) => candidate[key] !== value)
  ) {
    fail(code);
  }
  return expected;
}

function publicRlsRuntimeWriteContractReproductionEvidence(candidate) {
  exactRlsResult(
    candidate,
    RLS_REPRODUCTION_RESULT,
    "rls_runtime_write_contract_reproduction_invalid"
  );
  return RLS_REPRODUCTION_EVIDENCE;
}

function publicRlsPrivilegeInventoryContextReproductionEvidence(candidate) {
  return exactRlsResult(
    candidate,
    RLS_INVENTORY_CONTEXT_REPRODUCTION_RESULT,
    "rls_privilege_inventory_context_reproduction_invalid"
  );
}

async function runRlsPrivilegeInventoryContextPhase(options = {}) {
  const {
    state,
    runSubstep,
    runReproduction = runRlsPrivilegeInventoryContextReproduction
  } = options;
  if (
    !state || typeof runSubstep !== "function" ||
    typeof runReproduction !== "function"
  ) {
    fail("rls_privilege_inventory_context_orchestrator_invalid");
  }
  const candidate = await runReproduction(state, Object.freeze({ runSubstep }));
  try {
    return publicRlsPrivilegeInventoryContextReproductionEvidence(candidate);
  } catch (error) {
    return runSubstep("rls_inventory_role_reset", async () => { throw error; });
  }
}

function publicRlsRuntimeAttributesTextResolutionReproductionEvidence(candidate) {
  return exactRlsResult(
    candidate,
    RLS_RUNTIME_ATTRIBUTES_TEXT_RESOLUTION_RESULT,
    "rls_runtime_attributes_text_resolution_reproduction_invalid"
  );
}

async function runRlsRuntimeAttributesTextResolutionPhase(options = {}) {
  const {
    state,
    runSubstep,
    runReproduction = runRuntimeAttributesTextResolutionReproduction
  } = options;
  if (
    !state || typeof runSubstep !== "function" ||
    typeof runReproduction !== "function"
  ) {
    fail("rls_runtime_attributes_text_resolution_orchestrator_invalid");
  }
  const candidate = await runReproduction(state, Object.freeze({ runSubstep }));
  return runSubstep(
    "rls_runtime_attributes_evidence_validation",
    async () => publicRlsRuntimeAttributesTextResolutionReproductionEvidence(candidate)
  );
}

function publicRlsRoleGateEvidence(candidate) {
  return exactRlsResult(
    candidate,
    RLS_ROLE_GATE_RESULT,
    "rls_role_gate_evidence_invalid"
  );
}

function createRlsRuntimeWriteContractOrchestrator(options = {}) {
  const {
    state,
    gates,
    inventoryContextReproduction,
    runSubstep,
    legacyFailureCode = failureCode,
    runReproduction = runRlsRuntimeWriteContractReproduction,
    runCorrected = runRlsAndRoleGate
  } = options;
  if (
    !state || !gates || typeof gates.rls !== "function" ||
    typeof runSubstep !== "function" ||
    typeof legacyFailureCode !== "function" ||
    typeof runReproduction !== "function" ||
    typeof runCorrected !== "function"
  ) {
    fail("rls_runtime_write_contract_orchestrator_invalid");
  }
  const inventoryContext = exactRlsResult(
    inventoryContextReproduction,
    RLS_INVENTORY_CONTEXT_REPRODUCTION_RESULT,
    "rls_privilege_inventory_context_reproduction_required"
  );
  let status = "ready";
  let reproduction = null;

  async function reproduce() {
    if (status !== "ready") fail("rls_runtime_write_contract_sequence_invalid");
    status = "reproducing";
    try {
      await runSubstep("rls_base_gate", async () => {
        const base = await gates.rls({ state });
        exactRlsResult(base, RLS_BASE_GATE_RESULT, "rls_base_gate_evidence_invalid");
      });
      const candidate = await runReproduction(state, Object.freeze({
        inventoryContextReproduction: inventoryContext,
        legacyFailureCode,
        runSubstep
      }));
      await runSubstep(
        "rls_core_user_insert_reproduction",
        async () => exactRlsResult(
          candidate,
          RLS_REPRODUCTION_RESULT,
          "rls_runtime_write_contract_reproduction_invalid"
        )
      );
      reproduction = RLS_REPRODUCTION_RESULT;
      status = "reproduced";
      return publicRlsRuntimeWriteContractReproductionEvidence(reproduction);
    } catch (error) {
      status = "failed";
      throw error;
    }
  }

  async function correct(runtimeAttributesTextResolutionReproduction) {
    if (status !== "reproduced") {
      fail("rls_runtime_write_contract_reproduction_required");
    }
    status = "validating_runtime_attributes";
    try {
      const runtimeAttributes = exactRlsResult(
        runtimeAttributesTextResolutionReproduction,
        RLS_RUNTIME_ATTRIBUTES_TEXT_RESOLUTION_RESULT,
        "rls_runtime_attributes_text_resolution_reproduction_required"
      );
      status = "correcting";
      const candidate = await runCorrected(state, Object.freeze({
        baseRlsGatePassed: true,
        reproduction,
        runtimeAttributesTextResolutionReproduction: runtimeAttributes,
        runSubstep
      }));
      const evidence = await runSubstep(
        "rls_runtime_role_attributes",
        async () => publicRlsRoleGateEvidence(candidate)
      );
      status = "corrected";
      return evidence;
    } catch (error) {
      status = "failed";
      throw error;
    }
  }

  return Object.freeze({ reproduce, correct });
}

function backupRestoreCausalCode(error, fallback) {
  const candidate = String(error?.code || "");
  if (candidate === "postgres_rollback_failed") {
    const cause = String(error?.cause?.code || "");
    return SAFE_FAILURE.test(cause) ? cause : fallback;
  }
  return SAFE_FAILURE.test(candidate) ? candidate : fallback;
}

function sanitizedBackupRestoreFailureProvenance(candidate) {
  if (candidate == null) return null;
  const invalid = () => Object.freeze({
    operation: "unknown",
    substep: "unknown",
    boundary: "instrumentation",
    causalCode: "backup_restore_provenance_invalid",
    externalTransportProcessStarted: null,
    substepExact: false
  });
  if (
    !candidate || Object.getPrototypeOf(candidate) !== Object.prototype ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(BACKUP_RESTORE_PROVENANCE_KEYS) ||
    !BACKUP_RESTORE_OPERATIONS.has(candidate.operation) ||
    !BACKUP_RESTORE_SUBSTEPS.has(candidate.substep) ||
    !BACKUP_RESTORE_BOUNDARIES.has(candidate.boundary) ||
    !SAFE_FAILURE.test(String(candidate.causalCode || "")) ||
    !new Set([true, false, null]).has(
      candidate.externalTransportProcessStarted
    ) ||
    typeof candidate.substepExact !== "boolean"
  ) {
    return invalid();
  }
  const backupOperation = BACKUP_PROVENANCE_OPERATIONS.has(candidate.operation);
  const restoreOperation = RESTORE_PROVENANCE_OPERATIONS.has(candidate.operation);
  const backupSubstep = candidate.substep.startsWith("backup_");
  const restoreSubstep = candidate.substep.startsWith("restore_");
  const external = BACKUP_EXTERNAL_SUBSTEPS.includes(candidate.substep) ||
    RESTORE_EXTERNAL_SUBSTEPS.includes(candidate.substep);
  const internalCallback = BACKUP_RESTORE_INTERNAL_CALLBACKS.has(candidate.substep);
  const internalInterval = BACKUP_INTERNAL_INTERVALS.includes(candidate.substep) ||
    RESTORE_INTERNAL_INTERVALS.includes(candidate.substep);
  if (
    (candidate.operation === "unknown" && !(
      candidate.substep === "unknown" && candidate.boundary === "instrumentation"
    )) ||
    (backupOperation && !backupSubstep && candidate.substep !== "unknown") ||
    (restoreOperation && !restoreSubstep && candidate.substep !== "unknown") ||
    (candidate.boundary === "external_process" && (
      !external || candidate.substepExact !== true ||
      candidate.externalTransportProcessStarted !== true
    )) ||
    (candidate.boundary === "pre_execution_validation" && (
      !external || candidate.substepExact !== true ||
      candidate.externalTransportProcessStarted !== false
    )) ||
    (candidate.boundary === "internal_callback" && (
      !internalCallback || candidate.substepExact !== true ||
      candidate.externalTransportProcessStarted !== false
    )) ||
    (candidate.boundary === "internal_interval" && (
      !internalInterval || candidate.substepExact !== false ||
      candidate.externalTransportProcessStarted !== false
    )) ||
    (candidate.boundary === "instrumentation" && (
      candidate.substep !== "unknown" || candidate.substepExact !== false ||
      candidate.externalTransportProcessStarted !== null
    ))
  ) {
    return invalid();
  }
  return Object.freeze({
    operation: candidate.operation,
    substep: candidate.substep,
    boundary: candidate.boundary,
    causalCode: candidate.causalCode,
    externalTransportProcessStarted:
      candidate.externalTransportProcessStarted,
    substepExact: candidate.substepExact
  });
}

function createBackupRestoreProvenanceTracker(options = {}) {
  const requireSpawnProof = options.requireSpawnProof !== false;
  const requestBindings = new WeakMap();
  let firstFailure = null;
  let activeContext = null;

  function record(candidate) {
    if (firstFailure) return firstFailure;
    firstFailure = sanitizedBackupRestoreFailureProvenance(candidate);
    return firstFailure;
  }

  function recordInstrumentation(operation, causalCode) {
    return record({
      operation: BACKUP_RESTORE_OPERATIONS.has(operation) ? operation : "unknown",
      substep: "unknown",
      boundary: "instrumentation",
      causalCode: SAFE_FAILURE.test(String(causalCode || ""))
        ? causalCode
        : "backup_restore_provenance_instrumentation_failed",
      externalTransportProcessStarted: null,
      substepExact: false
    });
  }

  function wrapSpawn(spawnImpl) {
    if (typeof spawnImpl !== "function") {
      fail("backup_restore_provenance_spawn_invalid");
    }
    return function trackedSpawn(...args) {
      const invocation = activeContext?.activeExternal || null;
      if (invocation) invocation.externalTransportProcessStarted = false;
      let child;
      try {
        child = spawnImpl(...args);
      } catch (error) {
        if (invocation) invocation.externalTransportProcessStarted = false;
        throw error;
      }
      if (invocation && typeof child?.once === "function") {
        child.once("spawn", () => {
          invocation.externalTransportProcessStarted = true;
        });
        child.once("error", () => {
          if (invocation.externalTransportProcessStarted !== true) {
            invocation.externalTransportProcessStarted = false;
          }
        });
      } else if (invocation) {
        recordInstrumentation(
          activeContext.operation,
          "backup_restore_provenance_spawn_observer_invalid"
        );
      }
      return child;
    };
  }

  async function runInternalCallback(context, substep, operation, requireTrue = false) {
    try {
      const result = await operation();
      if (requireTrue && result !== true) {
        record({
          operation: context.operation,
          substep,
          boundary: "internal_callback",
          causalCode: "restore_behavioral_validation_failed",
          externalTransportProcessStarted: false,
          substepExact: true
        });
      }
      return result;
    } catch (error) {
      record({
        operation: context.operation,
        substep,
        boundary: "internal_callback",
        causalCode: backupRestoreCausalCode(
          error,
          "backup_restore_internal_callback_failed"
        ),
        externalTransportProcessStarted: false,
        substepExact: true
      });
      throw error;
    }
  }

  async function runClosingCallback(context, substep, operation) {
    try {
      return await operation();
    } catch (error) {
      if (!context.deferredClosingFailure) {
        context.deferredClosingFailure = Object.freeze({
          error,
          provenance: Object.freeze({
            operation: context.operation,
            substep,
            boundary: "internal_callback",
            causalCode: backupRestoreCausalCode(
              error,
              "backup_restore_internal_callback_failed"
            ),
            externalTransportProcessStarted: false,
            substepExact: true
          })
        });
      }
      return undefined;
    }
  }

  function wrapOperator(context, operator) {
    if (!operator || typeof operator !== "object") return operator;
    let policyCalls = 0;
    const callback = (name, substep) => typeof operator[name] === "function"
      ? (...args) => runInternalCallback(
          context,
          substep,
          () => operator[name](...args)
        )
      : operator[name];
    const wrapped = { ...operator };
    if (context.kind === "backup") {
      wrapped.acquireLocks = callback("acquireLocks", "backup_lock_acquire");
      wrapped.preflight = callback("preflight", "backup_preflight");
      if (typeof operator.assertTransientPoliciesAbsent === "function") {
        wrapped.assertTransientPoliciesAbsent = (...args) => {
          policyCalls += 1;
          if (policyCalls > 2) {
            recordInstrumentation(
              context.operation,
              "backup_restore_provenance_callback_sequence_invalid"
            );
            fail("backup_restore_provenance_callback_sequence_invalid");
          }
          return runInternalCallback(
            context,
            policyCalls === 1
              ? "backup_policy_before_snapshot"
              : "backup_policy_after_snapshot",
            () => operator.assertTransientPoliciesAbsent(...args)
          );
        };
      }
      wrapped.collectCatalogEvidence = callback(
        "collectCatalogEvidence",
        "backup_catalog_evidence"
      );
      if (typeof operator.releaseLocks === "function") {
        wrapped.releaseLocks = (...args) => runClosingCallback(
          context,
          "backup_lock_release",
          () => operator.releaseLocks(...args)
        );
      }
    } else {
      wrapped.acquireLocks = callback("acquireLocks", "restore_lock_acquire");
      wrapped.preflightEmptyTarget = callback(
        "preflightEmptyTarget",
        "restore_target_preflight"
      );
      if (typeof operator.assertTransientPoliciesAbsent === "function") {
        wrapped.assertTransientPoliciesAbsent = (...args) => {
          policyCalls += 1;
          if (policyCalls > 2) {
            recordInstrumentation(
              context.operation,
              "backup_restore_provenance_callback_sequence_invalid"
            );
            fail("backup_restore_provenance_callback_sequence_invalid");
          }
          return runInternalCallback(
            context,
            policyCalls === 1
              ? "restore_policy_before_apply"
              : "restore_policy_after_data",
            () => operator.assertTransientPoliciesAbsent(...args)
          );
        };
      }
      wrapped.collectCatalogEvidence = callback(
        "collectCatalogEvidence",
        "restore_catalog_evidence"
      );
      if (typeof operator.releaseLocks === "function") {
        wrapped.releaseLocks = (...args) => runClosingCallback(
          context,
          "restore_lock_release",
          () => operator.releaseLocks(...args)
        );
      }
    }
    return Object.freeze(wrapped);
  }

  function wrapExternalRunner(context, runTool) {
    if (typeof runTool !== "function") return runTool;
    return async (...args) => {
      const substep = context.externalSubsteps[context.externalIndex];
      if (!substep) {
        recordInstrumentation(
          context.operation,
          "backup_restore_provenance_sequence_invalid"
        );
        fail("backup_restore_provenance_sequence_invalid");
      }
      const invocation = {
        externalTransportProcessStarted: requireSpawnProof ? false : null,
        substep
      };
      context.activeExternal = invocation;
      let result;
      try {
        result = await runTool(...args);
      } catch (error) {
        if (invocation.externalTransportProcessStarted === null) {
          recordInstrumentation(
            context.operation,
            "backup_restore_provenance_spawn_unconfirmed"
          );
        } else {
          record({
            operation: context.operation,
            substep,
            boundary: invocation.externalTransportProcessStarted === true
              ? "external_process"
              : "pre_execution_validation",
            causalCode: backupRestoreCausalCode(
              error,
              invocation.externalTransportProcessStarted === true
                ? "backup_restore_external_transport_process_failed"
                : "backup_restore_pre_execution_validation_failed"
            ),
            externalTransportProcessStarted:
              invocation.externalTransportProcessStarted,
            substepExact: true
          });
        }
        throw error;
      } finally {
        context.activeExternal = null;
      }
      if (!result || !Number.isInteger(result.code)) {
        if (invocation.externalTransportProcessStarted === true) {
          record({
            operation: context.operation,
            substep,
            boundary: "external_process",
            causalCode:
              "backup_restore_external_transport_process_result_invalid",
            externalTransportProcessStarted: true,
            substepExact: true
          });
        } else {
          recordInstrumentation(
            context.operation,
            "backup_restore_provenance_spawn_unconfirmed"
          );
        }
        return result;
      }
      if (result.code !== 0) {
        if (invocation.externalTransportProcessStarted === true) {
          record({
            operation: context.operation,
            substep,
            boundary: "external_process",
            causalCode:
              "backup_restore_external_transport_process_nonzero",
            externalTransportProcessStarted: true,
            substepExact: true
          });
        } else {
          recordInstrumentation(
            context.operation,
            "backup_restore_provenance_spawn_unconfirmed"
          );
        }
        return result;
      }
      if (
        requireSpawnProof &&
        invocation.externalTransportProcessStarted !== true
      ) {
        recordInstrumentation(
          context.operation,
          "backup_restore_provenance_spawn_unconfirmed"
        );
        fail("backup_restore_provenance_spawn_unconfirmed");
      }
      context.externalIndex += 1;
      return result;
    };
  }

  function wrapVerifier(context, request, key, substep, requireTrue = false) {
    if (typeof request[key] !== "function") return request[key];
    return (...args) => runInternalCallback(
      context,
      substep,
      () => request[key](...args),
      requireTrue
    );
  }

  function wrapClosingVerifier(context, request, key, substep) {
    if (typeof request[key] !== "function") return request[key];
    return (...args) => runClosingCallback(
      context,
      substep,
      () => request[key](...args)
    );
  }

  function trackedRequest(context, request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      recordInstrumentation(
        context.operation,
        "backup_restore_provenance_request_invalid"
      );
      fail("backup_restore_provenance_request_invalid");
    }
    const tracked = {
      ...request,
      runTool: wrapExternalRunner(context, request.runTool)
    };
    if (request.operator) tracked.operator = wrapOperator(context, request.operator);
    const dependencies = request.dependencies && typeof request.dependencies === "object"
      ? { ...request.dependencies }
      : {};
    const operatorFactory = dependencies.createPostgresBackupOperator ||
      require("../src/persistence/postgres/backup-restore").createPostgresBackupOperator;
    if (!request.operator && typeof operatorFactory === "function") {
      dependencies.createPostgresBackupOperator = (pool) =>
        wrapOperator(context, operatorFactory(pool));
      tracked.dependencies = dependencies;
    } else if (request.dependencies) {
      tracked.dependencies = dependencies;
    }
    if (context.kind === "restore") {
      tracked.verifyRuntimeIsolation = wrapVerifier(
        context,
        request,
        "verifyRuntimeIsolation",
        "restore_runtime_isolation",
        true
      );
      tracked.verifyVault = wrapVerifier(
        context,
        request,
        "verifyVault",
        "restore_vault",
        true
      );
      tracked.verify2ACompatibility = wrapVerifier(
        context,
        request,
        "verify2ACompatibility",
        "restore_2a_compatibility",
        true
      );
      tracked.verifyRestoredProfile = wrapVerifier(
        context,
        request,
        "verifyRestoredProfile",
        "restore_profile_validation"
      );
      tracked.closeVerifiers = wrapClosingVerifier(
        context,
        request,
        "closeVerifiers",
        "restore_verifier_cleanup"
      );
    }
    return tracked;
  }

  function bindOperation(kind, operation, request) {
    const allowedOperations = kind === "backup"
      ? BACKUP_PROVENANCE_OPERATIONS
      : RESTORE_PROVENANCE_OPERATIONS;
    if (
      !allowedOperations.has(operation) || !request ||
      Object.getPrototypeOf(request) !== Object.prototype ||
      requestBindings.has(request)
    ) {
      recordInstrumentation(
        BACKUP_RESTORE_OPERATIONS.has(operation) ? operation : "unknown",
        "backup_restore_provenance_binding_invalid"
      );
      fail("backup_restore_provenance_binding_invalid");
    }
    requestBindings.set(request, { consumed: false, kind, operation });
    return request;
  }

  async function runOperation(kind, runner, request) {
    const binding = request && typeof request === "object"
      ? requestBindings.get(request)
      : null;
    if (
      !binding || binding.kind !== kind || binding.consumed === true ||
      typeof runner !== "function" || activeContext
    ) {
      recordInstrumentation(
        binding?.operation || "unknown",
        "backup_restore_provenance_operation_invalid"
      );
      fail("backup_restore_provenance_operation_invalid");
    }
    binding.consumed = true;
    const { operation } = binding;
    const context = {
      activeExternal: null,
      deferredClosingFailure: null,
      externalIndex: 0,
      externalSubsteps: kind === "backup"
        ? BACKUP_EXTERNAL_SUBSTEPS
        : RESTORE_EXTERNAL_SUBSTEPS,
      kind,
      operation
    };
    activeContext = context;
    try {
      const result = await runner(trackedRequest(context, request));
      if (context.deferredClosingFailure) {
        record(context.deferredClosingFailure.provenance);
        fail(context.deferredClosingFailure.provenance.causalCode);
      }
      if (context.externalIndex !== context.externalSubsteps.length) {
        recordInstrumentation(
          operation,
          "backup_restore_provenance_sequence_invalid"
        );
        fail("backup_restore_provenance_sequence_invalid");
      }
      return result;
    } catch (error) {
      if (!firstFailure) {
        if (context.deferredClosingFailure) {
          recordInstrumentation(
            operation,
            "backup_restore_provenance_closing_order_ambiguous"
          );
        } else {
          const intervals = kind === "backup"
            ? BACKUP_INTERNAL_INTERVALS
            : RESTORE_INTERNAL_INTERVALS;
          record({
            operation,
            substep: intervals[context.externalIndex],
            boundary: "internal_interval",
            causalCode: "backup_restore_internal_failure_unclassified",
            externalTransportProcessStarted: false,
            substepExact: false
          });
        }
      }
      throw error;
    } finally {
      activeContext = null;
    }
  }

  return Object.freeze({
    bindBackup(operation, request) {
      return bindOperation("backup", operation, request);
    },
    bindRestore(operation, request) {
      return bindOperation("restore", operation, request);
    },
    captureUnobservedFailure() {
      return recordInstrumentation(
        activeContext?.operation || "unknown",
        "backup_restore_provenance_unobserved"
      );
    },
    failure() {
      return firstFailure;
    },
    runBackup(runner, request) {
      return runOperation("backup", runner, request);
    },
    runRestore(runner, request) {
      return runOperation("restore", runner, request);
    },
    wrapSpawn
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactDirectory(candidate, root, code) {
  if (typeof candidate !== "string" || typeof root !== "string") fail(code);
  const absolute = path.resolve(candidate);
  const base = path.resolve(root);
  const relative = path.relative(base, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code);
  return absolute;
}

function freeBytes(target) {
  const stat = fs.statfsSync(target);
  const value = BigInt(stat.bavail) * BigInt(stat.bsize);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("linux_gate_disk_metric_invalid");
  return Number(value);
}

function publicPlatformEvidence(runnerTemp, runCommand) {
  return Promise.all([
    runCommand("stat", ["-f", "-c", "%T", runnerTemp], {
      timeoutMs: 10_000,
      cwd: runnerTemp,
      failureCode: "linux_gate_filesystem_probe_failed"
    }),
    runCommand("npm", ["--version"], {
      timeoutMs: 10_000,
      cwd: runnerTemp,
      failureCode: "linux_gate_npm_version_probe_failed"
    })
  ]).then(([filesystem, npm]) => {
    const fsType = filesystem.stdout.trim().replaceAll("/", "-");
    const npmVersion = npm.stdout.trim();
    if (!/^[a-zA-Z0-9._-]{1,63}$/.test(fsType) || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?$/.test(npmVersion)) {
      fail("linux_gate_platform_metric_invalid");
    }
    return Object.freeze({
      runner: "ubuntu-24.04",
      platform: process.platform,
      architecture: process.arch,
      kernel: os.release(),
      filesystem: fsType,
      node: process.version,
      npm: npmVersion
    });
  });
}

function gate4ConnectionCapacityEvidenceCorrelated(value) {
  try {
    const diagnosticsDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "gate4ConnectionCapacityDiagnostics"
    );
    const provenanceDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "gate4FailureProvenance"
    );
    const firstFailureDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "firstFailure"
    );
    for (const descriptor of [
      diagnosticsDescriptor,
      provenanceDescriptor,
      firstFailureDescriptor
    ]) {
      if (
        descriptor &&
        (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)
      ) return false;
    }
    const diagnosticsPresent = diagnosticsDescriptor !== undefined;
    const diagnostics = diagnosticsDescriptor?.value;
    const provenance = provenanceDescriptor?.value;
    const firstFailure = firstFailureDescriptor?.value;
    const capacityFailure = firstFailure?.phase === "vault" &&
      firstFailure?.code === "gate4_error_code_53300" &&
      isGate4ConnectionCapacityFailure(provenance);
    if (capacityFailure) {
      return diagnosticsPresent &&
        sanitizedGate4ConnectionCapacityDiagnostics(diagnostics) !== null;
    }
    return !diagnosticsPresent || diagnostics === null;
  } catch {
    return false;
  }
}

function evidenceSafe(value, depth = 0) {
  if (depth > 12) fail("linux_evidence_depth_invalid");
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Number.isSafeInteger(value);
  if (typeof value === "string") {
    return value.length <= 300 && !/[\0\r\n\u0001-\u001f\u007f]/.test(value) &&
      !/(?:^|[^0-9])(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?:\/(?:[0-9]|[12][0-9]|3[0-2]))?(?:$|[^0-9])/u.test(value) &&
      !/(?:postgres(?:ql)?:\/\/|password=|bearer\s|-----BEGIN|github_pat_|ghp_|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}\.)/i.test(value);
  }
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => evidenceSafe(item, depth + 1));
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 100) return false;
  if (!gate4ConnectionCapacityEvidenceCorrelated(value)) return false;
  if (
    Object.hasOwn(value, "firstFailure") &&
    Object.hasOwn(value, "gate4FailureProvenance")
  ) {
    const gate4 = sanitizedGate4FailureProvenance(value.gate4FailureProvenance);
    const phase = value.firstFailure?.phase;
    const code = value.firstFailure?.code;
    if (phase !== "vault") {
      if (value.gate4FailureProvenance !== null) return false;
    } else if (code === "gate4_failure_provenance_unobserved") {
      if (value.gate4FailureProvenance !== null) return false;
    } else if (!gate4 || code !== gate4.causalCode) return false;
  }
  return Object.entries(value).every(([key, item]) => (
    /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key) &&
    !/(password|connectionString|databaseUrl|rawState|token|secret|environmentVariables)/i.test(key) &&
    !/^(?:databaseHost|containerId|networkId|ipAddress|subnet|gateway)$/i.test(key) &&
    (key === "gate4FailureProvenance"
      ? item === null || sanitizedGate4FailureProvenance(item) !== null
      : key === "gate4ConnectionCapacityDiagnostics"
        ? item === null || sanitizedGate4ConnectionCapacityDiagnostics(item) !== null
        : evidenceSafe(item, depth + 1))
  ));
}

function sanitizedFailureEvidence(source, code = "linux_evidence_sanitization_failed") {
  if (!SAFE_FAILURE.test(code)) fail("linux_evidence_failure_code_invalid");
  const original = source?.firstFailure;
  const firstFailure = original &&
    typeof original.phase === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(original.phase) &&
    typeof original.code === "string" && SAFE_FAILURE.test(original.code)
    ? Object.freeze({ phase: original.phase, code: original.code })
    : Object.freeze({ phase: "secret_scan", code });
  const count = (name) => Number.isSafeInteger(source?.cleanup?.[name]) && source.cleanup[name] >= 0
    ? source.cleanup[name]
    : 1;
  const cleanup = Object.freeze({
    cleanupCompleted: source?.cleanup?.cleanupCompleted === true,
    containerResiduals: count("containerResiduals"),
    volumeResiduals: count("volumeResiduals"),
    networkResiduals: count("networkResiduals"),
    listenerResiduals: count("listenerResiduals"),
    temporaryRootResiduals: count("temporaryRootResiduals")
  });
  const sanitizedGate4 = sanitizedGate4FailureProvenance(
    source?.gate4FailureProvenance
  );
  let publishedFirstFailure = firstFailure;
  let gate4FailureProvenance = null;
  if (firstFailure.phase === "vault") {
    if (
      firstFailure.code !== "gate4_failure_provenance_unobserved" &&
      sanitizedGate4 && firstFailure.code === sanitizedGate4.causalCode
    ) {
      gate4FailureProvenance = sanitizedGate4;
    } else if (firstFailure.code !== "gate4_failure_provenance_unobserved") {
      publishedFirstFailure = Object.freeze({
        phase: "vault",
        code: "gate4_failure_provenance_unobserved"
      });
    }
  }
  let gate4ConnectionCapacityDiagnostics = null;
  if (
    publishedFirstFailure.phase === "vault" &&
    publishedFirstFailure.code === "gate4_error_code_53300" &&
    isGate4ConnectionCapacityFailure(gate4FailureProvenance)
  ) {
    const descriptor = source && typeof source === "object"
      ? Object.getOwnPropertyDescriptor(
        source,
        "gate4ConnectionCapacityDiagnostics"
      )
      : null;
    const candidate = descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : null;
    gate4ConnectionCapacityDiagnostics =
      sanitizedGate4ConnectionCapacityDiagnostics(candidate) ||
      gate4ConnectionCapacityInconclusiveFromCandidate(candidate);
  }
  return Object.freeze({
    format: 1,
    kind: "ia4tube-social-3a0p-linux-physical-gates",
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    productCommit: PRODUCT_COMMIT,
    imageDigest: IMAGE_DIGEST,
    status: "failed",
    phases: Object.freeze([]),
    firstFailure: publishedFirstFailure,
    backupRestoreFailureProvenance:
      sanitizedBackupRestoreFailureProvenance(
        source?.backupRestoreFailureProvenance
      ),
    gate3FailureProvenance: sanitizedGate3FailureProvenance(
      source?.gate3FailureProvenance
    ),
    gate4FailureProvenance,
    gate4ConnectionCapacityDiagnostics,
    rlsFailureProvenance: sanitizedRlsFailureProvenance(
      source?.rlsFailureProvenance
    ),
    cleanupFailure: typeof source?.cleanupFailure === "string" && SAFE_FAILURE.test(source.cleanupFailure)
      ? source.cleanupFailure
      : null,
    schemaProfileDiagnostics: sanitizedSchemaProfileDiagnostics(
      source?.schemaProfileDiagnostics
    ),
    cleanup,
    sanitizationFailure: true
  });
}

function containsMarkerInTree(root, markers) {
  const needles = markers.filter((value) => typeof value === "string" && value.length >= 16).map((value) => Buffer.from(value, "utf8"));
  let filesScanned = 0;
  let bytesScanned = 0;
  function scanFile(file, stat) {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const largest = Math.max(1, ...needles.map((needle) => needle.length));
    let carry = Buffer.alloc(0);
    const block = Buffer.alloc(1024 * 1024);
    try {
      while (true) {
        const read = fs.readSync(descriptor, block, 0, block.length, null);
        if (read === 0) break;
        bytesScanned += read;
        const combined = Buffer.concat([carry, block.subarray(0, read)]);
        if (needles.some((needle) => combined.indexOf(needle) >= 0)) return true;
        carry = Buffer.from(combined.subarray(Math.max(0, combined.length - largest + 1)));
      }
      filesScanned += 1;
      return false;
    } finally {
      carry.fill(0);
      block.fill(0);
      fs.closeSync(descriptor);
    }
  }
  function walk(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail("linux_gate_scan_symlink_refused");
      if (stat.isDirectory()) {
        if (walk(target)) return true;
      } else if (stat.isFile() && scanFile(target, stat)) {
        return true;
      } else if (!stat.isFile()) {
        fail("linux_gate_scan_special_file_refused");
      }
    }
    return false;
  }
  const present = fs.existsSync(root) ? walk(root) : false;
  return Object.freeze({ present, filesScanned, bytesScanned });
}

function publicBootstrapEvidence(bootstrap) {
  const checks = bootstrap?.checks;
  if (
    !checks || Object.getPrototypeOf(checks) !== Object.prototype ||
    checks.roleBootstrapIdempotent !== true || checks.runtimePoolMax3 !== true ||
    checks.runtimePoolConfiguredMax !== 3 ||
    checks.syntheticCredentialsOnly !== true
  ) fail("linux_gate_bootstrap_evidence_invalid");
  return Object.freeze({
    roleBootstrapIdempotent: true,
    runtimePoolMax3: true,
    runtimePoolConfiguredMax: 3,
    syntheticCredentialsOnly: true
  });
}

function isMigrationLedgerQuery(text) {
  if (typeof text !== "string" || text.includes(";")) return false;
  const normalized = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .toLowerCase();
  return normalized === [
    "select version,checksum_sha256 as checksum",
    "from ia4tube_migrations.schema_migrations order by version"
  ].join(" ");
}

function isLinuxRestoreDatabase(database) {
  return typeof database === "string" && LINUX_RESTORE_DATABASE.test(database);
}

function isRestoreEmptyTargetInventoryQuery(text) {
  return typeof text === "string" &&
    /\bapplication_schema_count\b/i.test(text) &&
    /\buser_relation_count\b/i.test(text) &&
    /\buser_routine_count\b/i.test(text) &&
    /\bstandalone_user_type_count\b/i.test(text);
}

function exactCount(row, key, code) {
  const value = Number(row?.[key]);
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

const RESTORE_TARGET_IDENTITY_SQL = [
  "SELECT",
  " current_database()=$1 AS database_exact,",
  " session_user=$2 AS login_exact,",
  " database_owner.rolname=$2 AS owner_exact",
  "FROM pg_catalog.pg_database database_info",
  "JOIN pg_catalog.pg_roles database_owner ON database_owner.oid=database_info.datdba",
  "WHERE database_info.datname=current_database()"
].join("\n");

const RESTORE_TARGET_CLUSTER_SNAPSHOT_SQL = [
  "SELECT COUNT(*)::integer AS role_count,",
  " jsonb_build_object(",
  "  'roles',COALESCE((",
  "   SELECT jsonb_agg(jsonb_build_array(role_info.rolname,role_info.rolcanlogin,role_info.rolsuper,role_info.rolcreatedb,role_info.rolcreaterole,role_info.rolinherit,role_info.rolreplication,role_info.rolbypassrls,role_info.rolconnlimit,role_info.rolpassword IS NOT NULL) ORDER BY role_info.rolname)",
  "   FROM pg_catalog.pg_roles role_info WHERE role_info.rolname=ANY($1::text[])",
  "  ),'[]'::jsonb),",
  "  'memberships',COALESCE((",
  "   SELECT jsonb_agg(jsonb_build_array(granted.rolname,member.rolname,grantor.rolname,membership.admin_option,membership.inherit_option,membership.set_option) ORDER BY granted.rolname,member.rolname,grantor.rolname)",
  "   FROM pg_catalog.pg_auth_members membership",
  "   JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid",
  "   JOIN pg_catalog.pg_roles member ON member.oid=membership.member",
  "   JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor",
  "   WHERE granted.rolname=ANY($1::text[]) OR member.rolname=ANY($1::text[])",
  "  ),'[]'::jsonb)",
  " )::text AS cluster_snapshot",
  "FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])"
].join("\n");

const RESTORE_TARGET_INVENTORY_SQL = [
  "SELECT",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_namespace WHERE nspname=ANY($1::text[])) AS application_schema_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname=ANY($1::text[]) AND relation.relkind IN('r','p','v','m','S','f')) AS application_relation_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname='ia4tube_migrations' AND relation.relname='environment_identity' AND relation.relkind IN('r','p')) AS environment_identity_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_namespace namespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname NOT IN('information_schema','public') AND NOT namespace.nspname=ANY($1::text[])) AS unexpected_schema_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND NOT namespace.nspname=ANY($1::text[]) AND relation.relkind IN('r','p','v','m','S','f')) AS unexpected_relation_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_proc routine JOIN pg_catalog.pg_namespace namespace ON namespace.oid=routine.pronamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND NOT namespace.nspname=ANY($1::text[])) AS unexpected_routine_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_type type_info JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type_info.typnamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND NOT namespace.nspname=ANY($1::text[]) AND type_info.typrelid=0 AND type_info.typtype IN('c','d','e','r','m')) AS unexpected_type_count"
].join("\n");

function validateRestoreTargetInventory(row, { allowBootstrap }) {
  const applicationSchemas = exactCount(row, "application_schema_count", "linux_gate_restore_inventory_invalid");
  const applicationRelations = exactCount(row, "application_relation_count", "linux_gate_restore_inventory_invalid");
  const environmentIdentity = exactCount(row, "environment_identity_count", "linux_gate_restore_inventory_invalid");
  const unexpected = [
    "unexpected_schema_count",
    "unexpected_relation_count",
    "unexpected_routine_count",
    "unexpected_type_count"
  ].map((key) => exactCount(row, key, "linux_gate_restore_inventory_invalid"));
  if (unexpected.some((count) => count !== 0)) fail("linux_gate_restore_target_unexpected_objects");
  const empty = applicationSchemas === 0 && applicationRelations === 0 && environmentIdentity === 0;
  const bootstrapOnly = applicationSchemas === 1 && applicationRelations === 1 && environmentIdentity === 1;
  if (!empty && (!allowBootstrap || !bootstrapOnly)) {
    fail("linux_gate_restore_target_bootstrap_footprint_invalid");
  }
  return empty;
}

async function prepareLinuxRestoreTarget({ database, query }) {
  if (!isLinuxRestoreDatabase(database) || typeof query !== "function") {
    fail("linux_gate_restore_target_contract_invalid");
  }
  const clusterRoles = [
    OWNER_ROLE,
    MIGRATOR_ROLE,
    "ia4tube_social_runtime",
    PROVISIONER_LOGIN,
    MIGRATION_LOGIN,
    RUNTIME_LOGIN
  ];
  let transactionStarted = false;
  try {
    await query("BEGIN");
    transactionStarted = true;
    const identity = await query(RESTORE_TARGET_IDENTITY_SQL, [database, PROVISIONER_LOGIN]);
    const identityRow = identity?.rows?.[0];
    if (identity?.rows?.length !== 1 || !identityRow.database_exact || !identityRow.login_exact || !identityRow.owner_exact) {
      fail("linux_gate_restore_target_identity_invalid");
    }
    const beforeCluster = await query(RESTORE_TARGET_CLUSTER_SNAPSHOT_SQL, [clusterRoles]);
    const beforeClusterRow = beforeCluster?.rows?.[0];
    if (
      exactCount(beforeClusterRow, "role_count", "linux_gate_restore_cluster_snapshot_invalid") !== clusterRoles.length ||
      typeof beforeClusterRow?.cluster_snapshot !== "string" || beforeClusterRow.cluster_snapshot.length < 2
    ) fail("linux_gate_restore_cluster_snapshot_invalid");
    const beforeInventory = await query(RESTORE_TARGET_INVENTORY_SQL, [RESTORE_APPLICATION_SCHEMAS]);
    validateRestoreTargetInventory(beforeInventory?.rows?.[0], { allowBootstrap: true });
    await query([
      `GRANT ${OWNER_ROLE} TO CURRENT_USER`,
      " WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
      " GRANTED BY CURRENT_USER"
    ].join("\n"));
    await query(`SET LOCAL ROLE ${OWNER_ROLE}`);
    for (const schema of RESTORE_APPLICATION_SCHEMAS) {
      await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await query("RESET ROLE");
    await query([
      `REVOKE ${OWNER_ROLE} FROM CURRENT_USER`,
      " GRANTED BY CURRENT_USER RESTRICT"
    ].join("\n"));
    const afterCluster = await query(RESTORE_TARGET_CLUSTER_SNAPSHOT_SQL, [clusterRoles]);
    const afterClusterRow = afterCluster?.rows?.[0];
    if (
      exactCount(afterClusterRow, "role_count", "linux_gate_restore_cluster_snapshot_invalid") !== clusterRoles.length ||
      afterClusterRow.cluster_snapshot !== beforeClusterRow.cluster_snapshot
    ) fail("linux_gate_restore_cluster_identity_changed");
    const afterInventory = await query(RESTORE_TARGET_INVENTORY_SQL, [RESTORE_APPLICATION_SCHEMAS]);
    if (!validateRestoreTargetInventory(afterInventory?.rows?.[0], { allowBootstrap: false })) {
      fail("linux_gate_restore_target_not_empty");
    }
    await query("COMMIT");
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        await query("ROLLBACK");
      } catch {}
    }
    throw error;
  }
}

async function runWithFirstFailurePreserved(operation, closingOperation) {
  if (
    typeof operation !== "function" ||
    typeof closingOperation !== "function"
  ) {
    fail("linux_gate_closing_operation_contract_invalid");
  }
  let operationFailed = false;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await closingOperation();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

function profile0003Fixture(randomUUID = crypto.randomUUID) {
  const companyId = randomUUID();
  const userId = randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(companyId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId) ||
    companyId === userId
  ) fail("linux_gate_profile0003_fixture_identity_invalid");
  return Object.freeze({
    companyId,
    userId,
    loginKeyDigest: crypto.createHash("sha256").update(`linux-profile-0003/${companyId}/${userId}`).digest("hex")
  });
}

async function profile0003Snapshot(pool, fixture, { seed, withTransactionImpl }) {
  if (!pool || typeof pool.query !== "function" || typeof withTransactionImpl !== "function") {
    fail("linux_gate_profile0003_fixture_pool_invalid");
  }
  return withTransactionImpl(pool, async (client) => {
    await client.query("SELECT pg_catalog.set_config('ia4tube.company_id',$1,true)", [fixture.companyId]);
    if (seed) {
      await client.query(
        "INSERT INTO ia4tube_social.companies(id,name,status,identity_derivation_version) VALUES($1,'Linux profile 0003 fixture','active','social-id-v1')",
        [fixture.companyId]
      );
      await client.query(
        "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest,status,auth_version) VALUES($1,$2,$3,'active',1)",
        [fixture.companyId, fixture.userId, fixture.loginKeyDigest]
      );
      await client.query(
        "INSERT INTO ia4tube_social.company_memberships(company_id,user_id,role,status) VALUES($1,$2,'owner','active')",
        [fixture.companyId, fixture.userId]
      );
    }
    const result = await client.query([
      "SELECT",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.companies WHERE id=$1) AS companies,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.users WHERE company_id=$1 AND id=$2 AND login_key_digest=$3) AS users,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.company_memberships WHERE company_id=$1 AND user_id=$2 AND role='owner') AS memberships,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.companies) AS tenant_companies,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.users WHERE company_id=$1) AS tenant_users,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.company_memberships WHERE company_id=$1) AS tenant_memberships"
    ].join("\n"), [fixture.companyId, fixture.userId, fixture.loginKeyDigest]);
    const row = result?.rows?.[0];
    const counts = [
      "companies", "users", "memberships", "tenant_companies", "tenant_users", "tenant_memberships"
    ].map((key) => exactCount(row, key, "linux_gate_profile0003_fixture_count_invalid"));
    if (
      result?.rows?.length !== 1 ||
      counts.slice(0, 3).some((count) => count !== 1) ||
      (seed && counts.some((count) => count !== 1))
    ) {
      fail(seed ? "linux_gate_profile0003_fixture_seed_invalid" : "linux_gate_profile0003_fixture_restore_invalid");
    }
    return Object.freeze({
      companies: counts[0],
      users: counts[1],
      memberships: counts[2],
      identitySha256: crypto.createHash("sha256")
        .update(canonicalJson({ companyId: fixture.companyId, userId: fixture.userId }))
        .digest("hex")
    });
  }, { role: OWNER_ROLE });
}

function createLinuxProfile0003PlansFacade({
  plans,
  makeMigrationPool,
  withTransactionImpl = require("../src/persistence/postgres/pool").withTransaction,
  randomUUID = crypto.randomUUID
}) {
  if (
    !plans || typeof plans.prepareBackupRestore !== "function" ||
    typeof makeMigrationPool !== "function" || typeof withTransactionImpl !== "function"
  ) fail("linux_gate_profile0003_plan_contract_invalid");
  const fixture = profile0003Fixture(randomUUID);
  let sourceSnapshot;
  let restoredSnapshot;
  let prepared = false;
  let restoreDatabase;
  let verifierInstalled = false;

  async function useMigrationPool(database, operation) {
    if (typeof database !== "string" || !database) fail("linux_gate_profile0003_database_invalid");
    const pool = makeMigrationPool(database);
    if (!pool || typeof pool.end !== "function") fail("linux_gate_profile0003_fixture_pool_invalid");
    const drain = createPhysicalPoolDrainTracker(pool);
    return runWithFirstFailurePreserved(
      () => operation(pool),
      () => drain.end(() => pool.end())
    );
  }

  const facade = Object.freeze({
    ...plans,
    async prepareBackupRestore(...args) {
      if (prepared || args.length > 1) {
        fail("linux_gate_profile0003_plan_reused");
      }
      prepared = true;
      const preparationHooks = Object.freeze({
        installProfile0003RestoreVerification() {
          if (verifierInstalled) {
            fail("linux_gate_profile0003_verifier_installation_invalid");
          }
          verifierInstalled = true;
          return async function verifyProfile0003FixtureRestored() {
            if (!sourceSnapshot || typeof restoreDatabase !== "string") {
              fail("linux_gate_profile0003_fixture_state_invalid");
            }
            restoredSnapshot = await useMigrationPool(
              restoreDatabase,
              async (pool) => {
                const candidate = await profile0003Snapshot(
                  pool,
                  fixture,
                  { seed: false, withTransactionImpl }
                );
                if (canonicalJson(candidate) !== canonicalJson(sourceSnapshot)) {
                  fail("linux_gate_profile0003_fixture_mismatch");
                }
                return candidate;
              }
            );
          };
        }
      });
      const plan = await plans.prepareBackupRestore(
        args[0],
        preparationHooks
      );
      const sourceDatabase = plan?.backup0003?.localBinding?.database;
      restoreDatabase = plan?.restore0003?.localBinding?.database;
      const verifyRestoredProfile = plan?.restore0003?.verifyRestoredProfile;
      if (
        !/^ia4tube_social_disposable_source_0003_[0-9a-f]{12}$/.test(String(sourceDatabase || "")) ||
        !/^ia4tube_social_disposable_restore_0003_[0-9a-f]{12}$/.test(String(restoreDatabase || "")) ||
        typeof verifyRestoredProfile !== "function" ||
        verifierInstalled !== true
      ) fail("linux_gate_profile0003_plan_binding_invalid");
      sourceSnapshot = await useMigrationPool(sourceDatabase, (pool) => profile0003Snapshot(
        pool,
        fixture,
        { seed: true, withTransactionImpl }
      ));
      return Object.freeze({ ...plan });
    }
  });

  return Object.freeze({
    plans: facade,
    evidence() {
      if (!sourceSnapshot || !restoredSnapshot || canonicalJson(sourceSnapshot) !== canonicalJson(restoredSnapshot)) {
        fail("linux_gate_profile0003_fixture_evidence_invalid");
      }
      return Object.freeze({
        profile0003SyntheticFixtureRestored: true,
        profile0003FixtureRows: sourceSnapshot.companies + sourceSnapshot.users + sourceSnapshot.memberships,
        profile0003FixtureIdentitySha256: sourceSnapshot.identitySha256
      });
    }
  });
}

function createLinuxRestoreConfigFacade({ backupProduct, backupDirectory, fileSystem = fs }) {
  if (
    !backupProduct || typeof backupProduct.loadRestoreConfig !== "function" ||
    typeof backupDirectory !== "string" || !path.isAbsolute(backupDirectory)
  ) fail("linux_gate_restore_config_facade_invalid");
  const expectedDirectory = path.resolve(backupDirectory);
  const loadRestoreConfig = backupProduct.loadRestoreConfig.bind(backupProduct);
  return Object.freeze({
    ...backupProduct,
    loadRestoreConfig(environment, options) {
      const supplied = environment?.SOCIAL_RESTORE_BUNDLE;
      if (typeof supplied !== "string" || !path.isAbsolute(supplied)) {
        fail("linux_gate_restore_bundle_path_invalid");
      }
      const bundlePath = path.resolve(supplied);
      if (path.dirname(bundlePath) !== expectedDirectory) {
        fail("linux_gate_restore_bundle_path_invalid");
      }
      if (fileSystem.existsSync(bundlePath)) {
        return loadRestoreConfig(environment, options);
      }
      if (!/^profile-(?:0003|0004)-[0-9a-f]{12}\.ia4sb$/.test(path.basename(bundlePath))) {
        fail("linux_gate_restore_bundle_placeholder_refused");
      }
      let descriptor;
      let created = false;
      let primaryFailed = false;
      let primaryFailure;
      let cleanupFailed = false;
      let cleanupFailure;
      let result;
      const recordCleanupFailure = (error) => {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupFailure = error;
        }
      };
      try {
        const directory = fileSystem.lstatSync(expectedDirectory);
        if (!directory.isDirectory() || directory.isSymbolicLink()) {
          fail("linux_gate_restore_bundle_directory_invalid");
        }
        descriptor = fileSystem.openSync(bundlePath, "wx", 0o600);
        created = true;
        fileSystem.closeSync(descriptor);
        descriptor = undefined;
        const placeholder = fileSystem.lstatSync(bundlePath);
        if (!placeholder.isFile() || placeholder.isSymbolicLink() || placeholder.size !== 0) {
          fail("linux_gate_restore_bundle_placeholder_invalid");
        }
        result = loadRestoreConfig(environment, options);
      } catch (error) {
        primaryFailed = true;
        primaryFailure = error;
      }
      if (descriptor !== undefined) {
        try {
          fileSystem.closeSync(descriptor);
        } catch (error) {
          recordCleanupFailure(error);
        }
      }
      if (created) {
        try {
          fileSystem.unlinkSync(bundlePath);
        } catch (error) {
          if (error?.code !== "ENOENT") recordCleanupFailure(error);
        }
        try {
          if (fileSystem.existsSync(bundlePath)) {
            fail("linux_gate_restore_bundle_placeholder_cleanup_failed");
          }
        } catch (error) {
          recordCleanupFailure(error);
        }
      }
      if (primaryFailed) throw primaryFailure;
      if (cleanupFailed) throw cleanupFailure;
      return result;
    }
  });
}

const physicalPoolDrainTrackers = new WeakMap();

function createPhysicalPoolDrainTracker(pool, options = {}) {
  const timeoutMs = options.timeoutMs ?? PHYSICAL_POOL_DRAIN_TIMEOUT_MS;
  if (
    !pool || typeof pool !== "object" || typeof pool.end !== "function" ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
  ) fail("linux_gate_pool_physical_drain_contract_invalid");
  const existing = physicalPoolDrainTrackers.get(pool);
  if (existing) return existing;

  const observable = typeof pool.on === "function" && typeof pool.removeListener === "function";
  const initialClients = Array.isArray(pool._clients) ? pool._clients : [];
  if (initialClients.length !== 0 && !observable) {
    fail("linux_gate_pool_physical_drain_events_missing");
  }
  const connected = new Set(initialClients);
  const pendingRemovals = new Set();
  const waiters = new Set();
  let endPromise;

  function settleWaiters(client) {
    for (const waiter of [...waiters]) {
      waiter.remaining.delete(client);
      if (waiter.remaining.size === 0) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(true);
      }
    }
  }
  function onConnect(client) {
    if (client && typeof client === "object") connected.add(client);
  }
  function onAcquire(client) {
    if (client && typeof client === "object") connected.add(client);
  }
  function onRelease(error, client) {
    if (error && client && typeof client === "object") {
      connected.add(client);
      pendingRemovals.add(client);
    }
  }
  function onRemove(client) {
    connected.delete(client);
    pendingRemovals.delete(client);
    settleWaiters(client);
  }
  if (observable) {
    pool.on("connect", onConnect);
    pool.on("acquire", onAcquire);
    pool.on("release", onRelease);
    pool.on("remove", onRemove);
  }

  function waitFor(clients) {
    const remaining = new Set(clients);
    if (remaining.size === 0) return Object.freeze({ promise: Promise.resolve(true), cancel() {} });
    let resolveWaiter;
    const promise = new Promise((resolve, reject) => {
      resolveWaiter = resolve;
      const waiter = {
        remaining,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new LinuxGateFailure("linux_gate_pool_physical_drain_timeout"));
        }, timeoutMs)
      };
      waiters.add(waiter);
    });
    return Object.freeze({
      promise,
      cancel() {
        const waiter = [...waiters].find((candidate) => candidate.remaining === remaining);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        resolveWaiter(false);
      }
    });
  }

  function detach() {
    if (!observable) return;
    pool.removeListener("connect", onConnect);
    pool.removeListener("acquire", onAcquire);
    pool.removeListener("release", onRelease);
    pool.removeListener("remove", onRemove);
  }

  const tracker = Object.freeze({
    async waitForPendingRemovals() {
      while (pendingRemovals.size !== 0) {
        await waitFor(pendingRemovals).promise;
      }
      return true;
    },
    pendingRemovalCount() {
      return pendingRemovals.size;
    },
    async end(endOperation = () => pool.end()) {
      if (typeof endOperation !== "function") fail("linux_gate_pool_physical_drain_contract_invalid");
      if (endPromise) return endPromise;
      const removal = waitFor(new Set([...connected, ...pendingRemovals]));
      let deadlineTimer;
      const deadline = new Promise((resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(new LinuxGateFailure("linux_gate_pool_physical_drain_timeout"));
        }, timeoutMs);
      });
      const operation = Promise.resolve().then(endOperation);
      const completion = Promise.all([operation, removal.promise]);
      endPromise = (async () => {
        try {
          const [result] = await Promise.race([completion, deadline]);
          detach();
          return result;
        } catch (error) {
          removal.cancel();
          detach();
          throw error;
        } finally {
          clearTimeout(deadlineTimer);
        }
      })();
      return endPromise;
    }
  });
  physicalPoolDrainTrackers.set(pool, tracker);
  return tracker;
}

function createDrainAwareRunTool(PlanPoolClass, runTool) {
  if (
    typeof PlanPoolClass?.awaitPendingRemovals !== "function" ||
    typeof runTool !== "function"
  ) fail("linux_gate_run_tool_drain_contract_invalid");
  return async (...args) => {
    await PlanPoolClass.awaitPendingRemovals();
    return runTool(...args);
  };
}

function publicBackupTransportEvidence(postgres) {
  const value = postgres?.backupTransportEvidence?.();
  const keys = [
    "localTlsDisabledOnlyInsideOwnedContainer",
    "logicalIdentityTlsContractValidated",
    "pgDumpStarted",
    "pgDumpSucceeded",
    "pgRestoreStarted",
    "pgRestoreSucceeded",
    "physicalDisposableTransportValidated",
    "productionTlsPhysicallyTestedInThisGate",
    "productionTlsPreviouslyProvedBySocial2B"
  ];
  if (
    !value || Object.getPrototypeOf(value) !== Object.prototype ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    Object.values(value).some((entry) => typeof entry !== "boolean") ||
    value.productionTlsPhysicallyTestedInThisGate !== false ||
    value.productionTlsPreviouslyProvedBySocial2B !== true
  ) {
    fail("linux_gate_backup_transport_evidence_invalid");
  }
  return Object.freeze({ ...value });
}

function createBackupTransportBridge(postgres, runTool, contract) {
  if (
    !postgres || typeof postgres.createBackupTransportBinding !== "function" ||
    typeof runTool !== "function"
  ) {
    fail("linux_gate_backup_transport_bridge_invalid");
  }
  const localBinding = postgres.createBackupTransportBinding(contract);
  const boundRunTool = async (plan, candidateBinding) => {
    if (candidateBinding !== localBinding) {
      fail("linux_gate_backup_transport_binding_invalid");
    }
    return runTool(plan, candidateBinding);
  };
  return Object.freeze({
    localBinding,
    runTool: boundRunTool
  });
}

function createLinuxProfileBackupRunner({
  localBackup,
  backupProduct,
  backupRestoreProvenance,
  recordDirectoryFsync
}) {
  if (
    typeof localBackup?.runProfileBackup !== "function" ||
    typeof backupProduct?.runLogicalBackup !== "function" ||
    (backupRestoreProvenance !== undefined &&
      typeof backupRestoreProvenance?.runBackup !== "function") ||
    typeof recordDirectoryFsync !== "function"
  ) {
    fail("linux_gate_profile_backup_runner_invalid");
  }
  const execute = function executeLinuxProfileBackup(request) {
    const requestDependencies = request?.dependencies || {};
    const runLogicalBackup = requestDependencies.runLogicalBackup ||
      backupProduct.runLogicalBackup;
    return localBackup.runProfileBackup({
      ...request,
      dependencies: {
        ...requestDependencies,
        async runLogicalBackup(args) {
          const result = await runLogicalBackup({
            ...args,
            requireBundleDirectoryFsync: true
          });
          if (result?.bundleDirectoryFsyncConfirmed !== true) {
            fail("linux_gate_bundle_directory_fsync_unconfirmed");
          }
          recordDirectoryFsync();
          return result;
        }
      }
    });
  };
  return function linuxProfileBackup(request) {
    if (backupRestoreProvenance === undefined) {
      return execute(request);
    }
    return backupRestoreProvenance.runBackup(execute, request);
  };
}

function createLinuxProfileRestoreRunner({
  localBackup,
  backupRestoreProvenance
}) {
  if (
    typeof localBackup?.runProfileRestore !== "function" ||
    (backupRestoreProvenance !== undefined &&
      typeof backupRestoreProvenance?.runRestore !== "function")
  ) {
    fail("linux_gate_profile_restore_runner_invalid");
  }
  const execute = (request) => localBackup.runProfileRestore(request);
  return function linuxProfileRestore(request) {
    if (backupRestoreProvenance === undefined) {
      return execute(request);
    }
    return backupRestoreProvenance.runRestore(execute, request);
  };
}

const retiredPoolHandles = new WeakSet();
const primaryRuntimeEndAfterMigrationHandoff = new WeakMap();

function retiredPoolHandle() {
  const handle = Object.freeze({
    retired: true,
    async end() { return undefined; }
  });
  retiredPoolHandles.add(handle);
  return handle;
}

function isRetiredPoolHandle(candidate) {
  return Boolean(
    candidate && retiredPoolHandles.has(candidate) &&
    candidate.retired === true && typeof candidate.end === "function"
  );
}

function createGate1MigrationPoolLifecycle({ plans, state, createMigrationPool }) {
  if (
    !plans || typeof plans.createRollbackAdapter !== "function" ||
    !state?.pools?.migration || typeof state.pools.migration.end !== "function" ||
    !state?.pools?.runtime || typeof state.pools.runtime.end !== "function" ||
    typeof createMigrationPool !== "function"
  ) {
    fail("linux_gate_gate1_pool_lifecycle_invalid");
  }
  const primaryMigrationDrain = createPhysicalPoolDrainTracker(state.pools.migration);
  createPhysicalPoolDrainTracker(state.pools.runtime);
  let rollbackAdapterCreated = false;
  let migrationRetired = false;
  let migrationRecreated = false;

  const facade = Object.freeze({
    ...plans,
    async createRollbackAdapter(...args) {
      if (rollbackAdapterCreated) fail("linux_gate_gate1_rollback_adapter_reused");
      rollbackAdapterCreated = true;
      const adapter = await plans.createRollbackAdapter(...args);
      if (!adapter || typeof adapter.captureCanonical0003 !== "function") {
        fail("linux_gate_gate1_rollback_adapter_invalid");
      }
      let captureStarted = false;
      return Object.freeze({
        ...adapter,
        async captureCanonical0003(...captureArgs) {
          if (captureStarted || migrationRetired) {
            fail("linux_gate_gate1_capture_reused");
          }
          captureStarted = true;
          const migration = state.pools.migration;
          const runtime = state.pools.runtime;
          if (
            !migration || migration.retired === true || typeof migration.end !== "function" ||
            !runtime || typeof runtime.end !== "function"
          ) {
            fail("linux_gate_gate1_primary_pool_invalid");
          }
          let retirementFailed = false;
          try {
            await primaryMigrationDrain.end(() => migration.end());
          } catch {
            retirementFailed = true;
          }
          state.pools = Object.freeze({ migration: retiredPoolHandle(), runtime });
          migrationRetired = true;
          if (retirementFailed) fail("linux_gate_gate1_primary_pool_retirement_failed");
          return adapter.captureCanonical0003(...captureArgs);
        }
      });
    }
  });

  return Object.freeze({
    plans: facade,
    async recreateMigrationPoolForEvidence() {
      if (
        !migrationRetired || migrationRecreated ||
        state.pools?.migration?.retired !== true ||
        !state.pools?.runtime || typeof state.pools.runtime.end !== "function"
      ) {
        fail("linux_gate_gate1_migration_recreation_refused");
      }
      const replacement = createMigrationPool();
      const replacementDrain = replacement && typeof replacement.end === "function"
        ? createPhysicalPoolDrainTracker(replacement)
        : null;
      if (
        !replacement || typeof replacement.end !== "function" ||
        replacement.options?.user !== MIGRATION_LOGIN ||
        replacement.options?.database !== DATABASE ||
        Number(replacement.options?.max) !== 2
      ) {
        try { await replacementDrain?.end(() => replacement.end()); } catch {}
        fail("linux_gate_gate1_migration_replacement_invalid");
      }
      state.pools = Object.freeze({
        migration: replacement,
        runtime: state.pools.runtime
      });
      migrationRecreated = true;
      return true;
    }
  });
}

async function retirePrimaryPoolsBeforeBackup(state) {
  const pools = state?.pools;
  const migration = pools?.migration;
  const runtime = pools?.runtime;
  if (!migration || typeof migration.end !== "function" || !runtime || typeof runtime.end !== "function") {
    fail("linux_gate_primary_migration_pool_invalid");
  }
  const migrationRetired = isRetiredPoolHandle(migration);
  const runtimeRetired = isRetiredPoolHandle(runtime);
  const migrationEnd = migration.end;
  const handedOffRuntimeEnd = migrationRetired && !runtimeRetired
    ? primaryRuntimeEndAfterMigrationHandoff.get(runtime)
    : null;
  const runtimeEnd = handedOffRuntimeEnd || runtime.end;
  if (
    (runtimeRetired && !migrationRetired) ||
    (migrationRetired && !runtimeRetired && (
      typeof handedOffRuntimeEnd !== "function" || runtime.end !== handedOffRuntimeEnd
    ))
  ) {
    fail("linux_gate_primary_migration_pool_invalid");
  }
  const identitiesIntact = () => Boolean(
    state.pools === pools && pools.migration === migration && pools.runtime === runtime &&
    migration.end === migrationEnd && runtime.end === runtimeEnd
  );
  const retire = (pool, endOperation) => isRetiredPoolHandle(pool)
    ? pool.end()
    : createPhysicalPoolDrainTracker(pool).end(() => {
      if (!identitiesIntact()) fail("linux_gate_primary_migration_pool_invalid");
      return endOperation.call(pool);
    });
  const closed = await Promise.allSettled([
    retire(migration, migrationEnd),
    retire(runtime, runtimeEnd)
  ]);
  if (closed.some((result) => result.status !== "fulfilled")) {
    fail("linux_gate_primary_pool_retirement_failed");
  }
  if (!identitiesIntact()) fail("linux_gate_primary_migration_pool_invalid");
  state.pools = Object.freeze({
    migration: retiredPoolHandle(),
    runtime: retiredPoolHandle()
  });
  if (handedOffRuntimeEnd) primaryRuntimeEndAfterMigrationHandoff.delete(runtime);
  return true;
}

async function retirePrimaryMigrationPoolBeforePersistedVault(state) {
  const pools = state?.pools;
  const migration = pools?.migration;
  const runtime = pools?.runtime;
  const migrationEnd = migration?.end;
  const runtimeEnd = runtime?.end;
  const waitingCountBeforeRetirement = migration?.waitingCount;
  const allMigrationClientsIdleBeforeRetirement = Boolean(
    Number.isSafeInteger(migration?.totalCount) && migration.totalCount >= 0 &&
    Number.isSafeInteger(migration?.idleCount) && migration.idleCount >= 0 &&
    migration.idleCount === migration.totalCount
  );
  if (
    !migration || isRetiredPoolHandle(migration) || migration.retired === true ||
    typeof migrationEnd !== "function" || migration.end !== migrationEnd ||
    migration.linuxMetricsLifecycle?.state !== "active" ||
    !runtime || isRetiredPoolHandle(runtime) || runtime.retired === true ||
    typeof runtimeEnd !== "function" || runtime.end !== runtimeEnd ||
    runtime.linuxMetricsLifecycle?.state !== "active" ||
    migration.options?.user !== MIGRATION_LOGIN ||
    migration.options?.database !== DATABASE ||
    migration.options?.max !== 2 ||
    waitingCountBeforeRetirement !== 0 ||
    !allMigrationClientsIdleBeforeRetirement
  ) {
    fail("linux_gate_primary_migration_pool_handoff_refused");
  }
  const runtimeIdentity = runtime;
  let migrationPoolEndCalls = 0;
  await createPhysicalPoolDrainTracker(migration).end(() => {
    const totalCountAtEnd = migration.totalCount;
    const idleCountAtEnd = migration.idleCount;
    const waitingCountAtEnd = migration.waitingCount;
    if (
      state.pools !== pools || state.pools.migration !== migration ||
      state.pools.runtime !== runtimeIdentity ||
      isRetiredPoolHandle(migration) || migration.retired === true ||
      migration.end !== migrationEnd ||
      migration.linuxMetricsLifecycle?.state !== "active" ||
      isRetiredPoolHandle(runtimeIdentity) || runtimeIdentity.retired === true ||
      runtimeIdentity.end !== runtimeEnd ||
      runtimeIdentity.linuxMetricsLifecycle?.state !== "active" ||
      migration.options?.user !== MIGRATION_LOGIN ||
      migration.options?.database !== DATABASE ||
      migration.options?.max !== 2 ||
      !Number.isSafeInteger(totalCountAtEnd) || totalCountAtEnd < 0 ||
      !Number.isSafeInteger(idleCountAtEnd) || idleCountAtEnd < 0 ||
      !Number.isSafeInteger(waitingCountAtEnd) || waitingCountAtEnd !== 0 ||
      idleCountAtEnd !== totalCountAtEnd
    ) {
      fail("linux_gate_primary_migration_pool_handoff_refused");
    }
    migrationPoolEndCalls += 1;
    return migrationEnd.call(migration);
  });
  if (
    migrationPoolEndCalls !== 1 ||
    state.pools !== pools || state.pools.migration !== migration ||
    state.pools.runtime !== runtimeIdentity ||
    migration.end !== migrationEnd || runtimeIdentity.end !== runtimeEnd ||
    migration.linuxMetricsLifecycle?.state !== "closed" ||
    runtimeIdentity.linuxMetricsLifecycle?.state !== "active"
  ) {
    fail("linux_gate_primary_migration_pool_handoff_unconfirmed");
  }
  state.pools = Object.freeze({
    migration: retiredPoolHandle(),
    runtime: runtimeIdentity
  });
  const proof = Object.freeze({
    migrationPoolRetired: isRetiredPoolHandle(state.pools.migration),
    migrationPoolEndCalls,
    runtimePoolPreserved:
      state.pools.runtime === runtimeIdentity &&
      runtimeIdentity.linuxMetricsLifecycle?.state === "active",
    waitingCountBeforeRetirement,
    allMigrationClientsIdleBeforeRetirement
  });
  if (
    proof.migrationPoolRetired !== true || proof.migrationPoolEndCalls !== 1 ||
    proof.runtimePoolPreserved !== true || proof.waitingCountBeforeRetirement !== 0 ||
    proof.allMigrationClientsIdleBeforeRetirement !== true
  ) {
    fail("linux_gate_primary_migration_pool_handoff_unconfirmed");
  }
  primaryRuntimeEndAfterMigrationHandoff.set(runtimeIdentity, runtimeEnd);
  return proof;
}

function isPrivateIpv4(value) {
  if (typeof value !== "string") return false;
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^(?:0|[1-9]\d{0,2})$/.test(octet))) return false;
  const values = octets.map(Number);
  if (values.some((octet) => octet > 255)) return false;
  return values[0] === 10 ||
    (values[0] === 172 && values[1] >= 16 && values[1] <= 31) ||
    (values[0] === 192 && values[1] === 168);
}

function exactPlainKeys(value, expected) {
  return Boolean(
    value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().length === expected.length &&
    Object.keys(value).sort().every((key, index) => key === expected[index])
  );
}

function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  try {
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  } finally {
    leftBuffer.fill(0);
    rightBuffer.fill(0);
  }
}

function parseVerifierUrl(value, expected) {
  let parsed;
  let login;
  let password;
  let database;
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    value.includes("?") || value.includes("#")
  ) {
    fail("linux_gate_login_verifier_uri_invalid");
  }
  try {
    parsed = new URL(value);
    login = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    fail("linux_gate_login_verifier_uri_invalid");
  }
  if (
    !new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
    parsed.toString() !== value ||
    parsed.hostname !== LOOPBACK || parsed.port !== String(LOGICAL_DATABASE_PORT) ||
    parsed.pathname[0] !== "/" || database !== expected.database ||
    login !== expected.login || password.length === 0 ||
    !equalSecret(password, expected.password) || parsed.search !== "" || parsed.hash !== ""
  ) {
    fail("linux_gate_login_verifier_uri_invalid");
  }
  return Object.freeze({ login, password, database });
}

function createVerifiedLoginCredentialPoolBridge(postgres, contract, options = {}) {
  if (
    !postgres || typeof postgres.InstrumentedPool !== "function" ||
    !exactPlainKeys(contract, [
      "database", "migrationLogin", "passwords", "provisionerLogin", "runtimeLogin", "target"
    ]) ||
    !exactPlainKeys(contract.target, ["host", "port"]) ||
    contract.target.host !== LOOPBACK || contract.target.port !== LOGICAL_DATABASE_PORT ||
    !LINUX_VERIFIER_DATABASE.test(String(contract.database || "")) ||
    contract.provisionerLogin !== PROVISIONER_LOGIN ||
    contract.migrationLogin !== MIGRATION_LOGIN || contract.runtimeLogin !== RUNTIME_LOGIN ||
    !contract.passwords || Object.getPrototypeOf(contract.passwords) !== Object.prototype ||
    Object.keys(contract.passwords).sort().join("\0") !==
      [MIGRATION_LOGIN, PROVISIONER_LOGIN, RUNTIME_LOGIN].sort().join("\0") ||
    [PROVISIONER_LOGIN, MIGRATION_LOGIN, RUNTIME_LOGIN]
      .some((login) => typeof contract.passwords[login] !== "string" || contract.passwords[login].length < 32)
  ) {
    fail("linux_gate_login_verifier_contract_invalid");
  }
  if (
    !options || Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).some((key) => key !== "environment")
  ) {
    fail("linux_gate_login_verifier_contract_invalid");
  }
  const environment = options.environment === undefined ? process.env : options.environment;
  if (
    !environment || typeof environment !== "object" ||
    Object.keys(environment).some((name) => {
      const normalized = name.toUpperCase();
      return /^PG[A-Z0-9_]*$/.test(normalized) ||
        LOGIN_VERIFIER_AMBIENT_URL_NAMES.has(normalized);
    })
  ) {
    fail("linux_gate_login_verifier_ambient_environment_refused");
  }
  const physicalHost = postgres.databaseHost;
  if (!isPrivateIpv4(physicalHost) || postgres.port !== LOGICAL_DATABASE_PORT) {
    fail("linux_gate_login_verifier_private_transport_invalid");
  }
  const provenance = Symbol("linux-login-verifier-provenance");
  let provisionerPoolAuthorized = false;

  function assertBaseShape(configuration, applicationName) {
    if (
      !exactPlainKeys(configuration, LOGIN_VERIFIER_POOL_KEYS) ||
      configuration.host !== LOOPBACK || configuration.port !== LOGICAL_DATABASE_PORT ||
      configuration.database !== contract.database || configuration.user !== PROVISIONER_LOGIN ||
      !equalSecret(configuration.password, contract.passwords[PROVISIONER_LOGIN]) ||
      configuration.ssl !== false || configuration.max !== 1 || configuration.min !== 0 ||
      configuration.connectionTimeoutMillis !== 5_000 || configuration.idleTimeoutMillis !== 5_000 ||
      configuration.query_timeout !== 15_000 || configuration.application_name !== applicationName ||
      configuration.options !== LOGIN_VERIFIER_SESSION_OPTIONS ||
      configuration.allowExitOnIdle !== false
    ) {
      fail("linux_gate_login_verifier_configuration_invalid");
    }
  }

  function authorizeProvisionerPool(configuration) {
    if (provisionerPoolAuthorized) fail("linux_gate_login_verifier_provenance_invalid");
    assertBaseShape(configuration, "ia4tube-social-3a0p-provisioner");
    parseVerifierUrl(configuration.connectionString, {
      database: contract.database,
      login: PROVISIONER_LOGIN,
      password: contract.passwords[PROVISIONER_LOGIN]
    });
    const authorized = { ...configuration };
    Object.defineProperty(authorized, provenance, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: true
    });
    provisionerPoolAuthorized = true;
    return Object.freeze(authorized);
  }

  class VerifiedLoginCredentialPool extends postgres.InstrumentedPool {
    constructor(configuration) {
      const symbols = configuration && typeof configuration === "object"
        ? Object.getOwnPropertySymbols(configuration)
        : [];
      const stringKeys = configuration && typeof configuration === "object"
        ? Object.keys(configuration).sort()
        : [];
      if (
        symbols.length !== 1 || symbols[0] !== provenance || configuration[provenance] !== true ||
        stringKeys.length !== LOGIN_VERIFIER_POOL_KEYS.length ||
        !stringKeys.every((key, index) => key === LOGIN_VERIFIER_POOL_KEYS[index]) ||
        postgres.databaseHost !== physicalHost || postgres.port !== LOGICAL_DATABASE_PORT
      ) {
        fail("linux_gate_login_verifier_provenance_invalid");
      }
      let uri;
      let login;
      try {
        uri = new URL(configuration.connectionString);
        login = decodeURIComponent(uri.username);
      } catch {
        fail("linux_gate_login_verifier_uri_invalid");
      }
      const expected = login === MIGRATION_LOGIN
        ? { password: contract.passwords[MIGRATION_LOGIN], applicationName: "ia4tube-social-migration-login-check" }
        : login === RUNTIME_LOGIN
          ? { password: contract.passwords[RUNTIME_LOGIN], applicationName: "ia4tube-social-runtime-login-check" }
          : null;
      if (!expected) fail("linux_gate_login_verifier_login_invalid");
      assertBaseShape(configuration, expected.applicationName);
      const parsed = parseVerifierUrl(configuration.connectionString, {
        database: contract.database,
        login,
        password: expected.password
      });
      super({
        host: physicalHost,
        port: LOGICAL_DATABASE_PORT,
        database: parsed.database,
        user: parsed.login,
        password: parsed.password,
        ssl: false,
        max: 1,
        min: 0,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        query_timeout: 15_000,
        application_name: expected.applicationName,
        options: LOGIN_VERIFIER_SESSION_OPTIONS,
        allowExitOnIdle: false
      });
    }
  }

  return Object.freeze({ PoolClass: VerifiedLoginCredentialPool, authorizeProvisionerPool });
}

function createPrivatePlanPoolOptionsAdapter(postgres) {
  if (!postgres || typeof postgres.adaptLogicalPoolOptions !== "function") {
    fail("linux_gate_plan_pool_transport_contract_invalid");
  }
  const databaseHost = postgres.databaseHost;
  if (!isPrivateIpv4(databaseHost)) fail("linux_gate_plan_pool_private_host_invalid");
  return (options) => {
    if (
      !options || Object.getPrototypeOf(options) !== Object.prototype ||
      options.host !== LOOPBACK || options.port !== LOGICAL_DATABASE_PORT ||
      options.ssl !== false || options.connectionString != null
    ) {
      fail("linux_gate_plan_pool_logical_transport_invalid");
    }
    const logicalKeys = Object.keys(options)
      .filter((key) => key !== "connectionString" || options[key] != null)
      .sort();
    const adapted = postgres.adaptLogicalPoolOptions(options);
    const physicalKeys = adapted && Object.getPrototypeOf(adapted) === Object.prototype
      ? Object.keys(adapted).filter((key) => key !== "connectionString" || adapted[key] != null).sort()
      : [];
    if (
      !adapted || Object.getPrototypeOf(adapted) !== Object.prototype || adapted === options ||
      options.host !== LOOPBACK || options.port !== LOGICAL_DATABASE_PORT || options.ssl !== false ||
      adapted.host !== databaseHost || adapted.port !== LOGICAL_DATABASE_PORT || adapted.ssl !== false ||
      adapted.connectionString != null ||
      logicalKeys.length !== physicalKeys.length ||
      logicalKeys.some((key, index) => key !== physicalKeys[index]) ||
      logicalKeys.some((key) => key !== "host" && key !== "port" && !Object.is(adapted[key], options[key]))
    ) {
      fail("linux_gate_plan_pool_physical_transport_invalid");
    }
    return adapted;
  };
}

function createRoleScopedPlanPoolClass(
  BasePool,
  withTransactionImpl = require("../src/persistence/postgres/pool").withTransaction,
  createMigrationPool = null,
  prepareRestoreTarget = prepareLinuxRestoreTarget,
  adaptPoolOptions = (options) => options
) {
  if (
    typeof BasePool !== "function" || typeof withTransactionImpl !== "function" ||
    typeof prepareRestoreTarget !== "function" || typeof adaptPoolOptions !== "function"
  ) {
    fail("linux_gate_plan_pool_contract_invalid");
  }
  const instances = new Set();
  return class LinuxRoleScopedPlanPool extends BasePool {
    constructor(options) {
      super(adaptPoolOptions(options));
      this.linuxPhysicalDrain = createPhysicalPoolDrainTracker(this);
      this.linuxRestoreTargetPrepared = false;
      this.linuxRestoreTargetPreparing = null;
      instances.add(this);
    }

    query(...queryArgs) {
      const [text, values] = queryArgs;
      if (!isMigrationLedgerQuery(text)) return super.query(...queryArgs);
      const callback = typeof queryArgs.at(-1) === "function" ? queryArgs.at(-1) : null;
      const queryValues = typeof values === "function" ? undefined : values;
      const operation = () => {
        if (this.options?.user !== MIGRATION_LOGIN) fail("linux_gate_ledger_login_invalid");
        return withTransactionImpl(
          this,
          (client) => queryValues === undefined
            ? client.query(text)
            : client.query(text, queryValues),
          { role: MIGRATOR_ROLE }
        );
      };
      if (!callback) return Promise.resolve().then(operation);
      Promise.resolve().then(operation).then(
        (result) => callback(null, result),
        (error) => callback(error)
      );
      return undefined;
    }

    _wrapPlanClient(client) {
      if (!client || typeof client.release !== "function" || typeof client.query !== "function") {
        fail("linux_gate_plan_client_invalid");
      }
      const query = client.query.bind(client);
      client.query = (...queryArgs) => {
        const [text, values] = queryArgs;
        const restoreInventory = isRestoreEmptyTargetInventoryQuery(text);
        const ledger = isMigrationLedgerQuery(text) && this.options?.user === PROVISIONER_LOGIN;
        if (!restoreInventory && !ledger) {
          return query(...queryArgs);
        }
        const callback = typeof queryArgs.at(-1) === "function" ? queryArgs.at(-1) : null;
        const queryValues = typeof values === "function" ? undefined : values;
        const operation = async () => {
          if (restoreInventory) {
            if (!isLinuxRestoreDatabase(this.options?.database)) {
              fail("linux_gate_restore_target_database_invalid");
            }
            if (!this.linuxRestoreTargetPrepared) {
              if (!this.linuxRestoreTargetPreparing) {
                this.linuxRestoreTargetPreparing = Promise.resolve(prepareRestoreTarget({
                  database: this.options.database,
                  query
                })).then((prepared) => {
                  if (prepared !== true) fail("linux_gate_restore_target_preparation_unconfirmed");
                  this.linuxRestoreTargetPrepared = true;
                });
              }
              await this.linuxRestoreTargetPreparing;
            }
          }
          if (!ledger) return query(text, values);
          if (typeof createMigrationPool !== "function") fail("linux_gate_backup_catalog_role_missing");
          const migrationPool = createMigrationPool(this.options?.database);
          const migrationDrain = createPhysicalPoolDrainTracker(migrationPool);
          return runWithFirstFailurePreserved(
            () => withTransactionImpl(
              migrationPool,
              (migrationClient) => queryValues === undefined
                ? migrationClient.query(text)
                : migrationClient.query(text, queryValues),
              { role: MIGRATOR_ROLE }
            ),
            () => migrationDrain.end(() => migrationPool.end())
          );
        };
        if (!callback) return operation();
        operation().then(
          (result) => callback(null, result),
          (error) => callback(error)
        );
        return undefined;
      };
      const release = client.release.bind(client);
      let released = false;
      client.release = (error) => {
        if (released) return undefined;
        released = true;
        return release(error || Object.assign(new Error("ephemeral plan connection"), {
          code: "linux_gate_plan_ephemeral_release"
        }));
      };
      return client;
    }

    connect(callback) {
      if (typeof callback === "function") {
        LinuxRoleScopedPlanPool.awaitPendingRemovals().then(
          () => super.connect((error, client) => {
            if (error) return callback(error);
            try {
              const wrapped = this._wrapPlanClient(client);
              return callback(null, wrapped, wrapped.release);
            } catch (wrapError) {
              try { client?.release?.(wrapError); } catch {}
              return callback(wrapError);
            }
          }),
          (error) => callback(error)
        );
        return undefined;
      }
      if (callback !== undefined) fail("linux_gate_plan_connect_contract_invalid");
      return LinuxRoleScopedPlanPool.awaitPendingRemovals()
        .then(() => super.connect())
        .then((client) => this._wrapPlanClient(client));
    }

    async end(...args) {
      try {
        return await this.linuxPhysicalDrain.end(() => super.end(...args));
      } finally {
        instances.delete(this);
      }
    }

    static async awaitPendingRemovals() {
      while (true) {
        const snapshot = [...instances];
        await Promise.all(snapshot.map((pool) => pool.linuxPhysicalDrain.waitForPendingRemovals()));
        if ([...instances].every((pool) => pool.linuxPhysicalDrain.pendingRemovalCount() === 0)) {
          return true;
        }
      }
    }

    static async closeAll() {
      const failures = [];
      for (const pool of [...instances]) {
        try { await pool.end(); } catch (error) { failures.push(error); }
      }
      if (failures.length !== 0 || instances.size !== 0) fail("linux_gate_plan_pool_cleanup_failed");
      return true;
    }
  };
}

function definitiveSchemaProfile(expectedProfileId) {
  if (
    typeof expectedProfileId !== "string" ||
    !SCHEMA_PROFILE_IDS.includes(expectedProfileId)
  ) {
    fail("linux_gate_schema_profile_invalid");
  }
  const backup = require("../src/persistence/postgres/backup-restore");
  const profiles = backup.SCHEMA_PROFILES;
  const profile = Array.isArray(profiles)
    ? profiles.find((candidate) => candidate?.id === expectedProfileId)
    : undefined;
  if (
    !profile ||
    !Array.isArray(profile.rlsTables) ||
    profile.rlsTables.length < 1 ||
    profile.rlsTables.some(
      (table) => typeof table !== "string" || !/^[a-z][a-z0-9_]{2,62}$/.test(table)
    )
  ) {
    fail("linux_gate_schema_profile_contract_invalid");
  }
  return profile;
}

function closedSchemaProfileDiagnostics(candidate) {
  if (candidate === null || candidate === undefined) return null;
  if (
    !candidate ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(SCHEMA_PROFILE_DIAGNOSTIC_KEYS)
  ) {
    fail("linux_gate_schema_profile_diagnostics_invalid");
  }
  const snapshot = Object.freeze({
    observedRelationCount: candidate.observedRelationCount,
    expectedRelationCount: candidate.expectedRelationCount,
    missingRelationCount: candidate.missingRelationCount,
    unexpectedRelationCount: candidate.unexpectedRelationCount,
    kindMismatchCount: candidate.kindMismatchCount,
    ownerMismatchCount: candidate.ownerMismatchCount
  });
  if (
    Object.values(snapshot).some(
      (value) => !Number.isSafeInteger(value) || value < 0
    ) ||
    snapshot.missingRelationCount > snapshot.expectedRelationCount ||
    snapshot.unexpectedRelationCount > snapshot.observedRelationCount ||
    snapshot.kindMismatchCount > Math.min(
      snapshot.observedRelationCount,
      snapshot.expectedRelationCount
    ) ||
    snapshot.ownerMismatchCount > snapshot.observedRelationCount
  ) {
    fail("linux_gate_schema_profile_diagnostics_invalid");
  }
  return snapshot;
}

function sanitizedSchemaProfileDiagnostics(candidate) {
  try {
    return closedSchemaProfileDiagnostics(candidate);
  } catch {
    return null;
  }
}

async function collectSchemaProfileDiagnostics(pool, profile) {
  if (!pool || typeof pool.query !== "function") {
    fail("linux_gate_schema_profile_diagnostics_pool_invalid");
  }
  const expectedRelations = Object.freeze([
    ...profile.rlsTables,
    "runtime_schema_contract"
  ]);
  const result = await pool.query(
    [
      "WITH expected(relation_name, object_kind) AS (",
      "  SELECT relation_name,",
      "    CASE WHEN relation_name = 'runtime_schema_contract'",
      "      THEN 'v'::\"char\" ELSE 'r'::\"char\" END",
      "  FROM unnest($1::text[]) AS supplied(relation_name)",
      "), observed AS (",
      "  SELECT relation.relname AS relation_name,",
      "    relation.relkind AS object_kind,",
      "    owner.rolname AS owner_name",
      "  FROM pg_catalog.pg_class relation",
      "  JOIN pg_catalog.pg_namespace namespace",
      "    ON namespace.oid = relation.relnamespace",
      "  JOIN pg_catalog.pg_roles owner",
      "    ON owner.oid = relation.relowner",
      "  WHERE namespace.nspname = 'ia4tube_social'",
      "    AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')",
      ")",
      "SELECT",
      "  (SELECT COUNT(*)::integer FROM observed) AS observed_relation_count,",
      "  (SELECT COUNT(*)::integer FROM expected) AS expected_relation_count,",
      "  (SELECT COUNT(*)::integer FROM expected",
      "    LEFT JOIN observed USING (relation_name)",
      "    WHERE observed.relation_name IS NULL) AS missing_relation_count,",
      "  (SELECT COUNT(*)::integer FROM observed",
      "    LEFT JOIN expected USING (relation_name)",
      "    WHERE expected.relation_name IS NULL) AS unexpected_relation_count,",
      "  (SELECT COUNT(*)::integer FROM observed",
      "    JOIN expected USING (relation_name)",
      "    WHERE observed.object_kind <> expected.object_kind) AS kind_mismatch_count,",
      "  (SELECT COUNT(*)::integer FROM observed",
      "    WHERE observed.owner_name <> $2) AS owner_mismatch_count"
    ].join("\n"),
    [expectedRelations, OWNER_ROLE]
  );
  const row = result?.rows?.[0];
  const diagnostics = closedSchemaProfileDiagnostics({
    observedRelationCount: Number(row?.observed_relation_count),
    expectedRelationCount: Number(row?.expected_relation_count),
    missingRelationCount: Number(row?.missing_relation_count),
    unexpectedRelationCount: Number(row?.unexpected_relation_count),
    kindMismatchCount: Number(row?.kind_mismatch_count),
    ownerMismatchCount: Number(row?.owner_mismatch_count)
  });
  if (
    result?.rowCount !== 1 ||
    diagnostics.expectedRelationCount !== expectedRelations.length
  ) {
    fail("linux_gate_schema_profile_diagnostics_invalid");
  }
  return diagnostics;
}

function createRestoreBehaviorFacade(legacy2ARoot, overrides = {}) {
  if (
    !overrides ||
    Object.getPrototypeOf(overrides) !== Object.prototype
  ) {
    fail("linux_gate_restore_behavior_facade_invalid");
  }
  const restoreBehavior = overrides.restoreBehavior === undefined
    ? require("../src/persistence/postgres/restore-behavior-verifiers")
    : overrides.restoreBehavior;
  const runtimeValidation = overrides.runtimeValidation === undefined
    ? require("../src/persistence/postgres/runtime-validation")
    : overrides.runtimeValidation;
  const currentCreateSocialRepository = require(
    "../src/persistence/postgres/social-repository"
  ).createSocialRepository;
  const createProfileAwareSocialRepositoryFactory = require(
    "./social-3a0p-local-windows-physical-plans"
  ).createProfileAwareSocialRepositoryFactory;
  if (
    !restoreBehavior ||
    typeof restoreBehavior.createRestoreBehaviorVerifiers !== "function" ||
    typeof restoreBehavior.loadLegacy2ADependencies !== "function" ||
    !runtimeValidation ||
    typeof runtimeValidation.verifyRuntimeSchema !== "function" ||
    typeof currentCreateSocialRepository !== "function" ||
    typeof createProfileAwareSocialRepositoryFactory !== "function"
  ) {
    fail("linux_gate_restore_behavior_facade_invalid");
  }

  // This is deliberately eager and has no current-code fallback. The existing
  // loader proves the fixed commit, closed manifest and every source hash.
  const legacy = restoreBehavior.loadLegacy2ADependencies(legacy2ARoot);
  const legacyOperationNames = [
    "createCompanyScopedRepository",
    "createSocialCredentialService",
    "createSocialRepository",
    "createSocialVault",
    "verifyRuntimeRole",
    "verifyRuntimeSchema"
  ];
  if (
    !legacy ||
    typeof legacy !== "object" ||
    legacyOperationNames.some((name) => typeof legacy[name] !== "function")
  ) {
    fail("linux_gate_restore_behavior_2a_dependencies_invalid");
  }

  let diagnostics = null;

  function selectedVerifier(expectedProfileId) {
    definitiveSchemaProfile(expectedProfileId);
    return expectedProfileId === SCHEMA_PROFILE_0003
      ? legacy.verifyRuntimeSchema
      : runtimeValidation.verifyRuntimeSchema;
  }

  function bindVerifier(expectedProfileId) {
    const profile = definitiveSchemaProfile(expectedProfileId);
    const verifier = selectedVerifier(expectedProfileId);
    return async function verifyProfileRuntimeSchema(pool, role) {
      try {
        return await verifier(pool, role);
      } catch (error) {
        if (
          error?.code === "postgres_relation_owner_mismatch" &&
          diagnostics === null
        ) {
          try {
            diagnostics = await collectSchemaProfileDiagnostics(pool, profile);
          } catch {
            // The original schema failure remains the first and only failure.
          }
        }
        throw error;
      }
    };
  }

  function profileBoundLegacyDependencies(verifyRuntimeSchemaForProfile) {
    return Object.freeze({
      createCompanyScopedRepository: legacy.createCompanyScopedRepository,
      createSocialCredentialService: legacy.createSocialCredentialService,
      createSocialRepository: legacy.createSocialRepository,
      createSocialVault: legacy.createSocialVault,
      verifyRuntimeRole: legacy.verifyRuntimeRole,
      verifyRuntimeSchema: verifyRuntimeSchemaForProfile
    });
  }

  return Object.freeze({
    createRestoreBehaviorVerifiers(options = {}) {
      if (
        !options ||
        Object.getPrototypeOf(options) !== Object.prototype ||
        Object.hasOwn(options, "legacyDependencies")
      ) {
        fail("linux_gate_restore_behavior_options_invalid");
      }
      const expectedProfileId = options.expectedProfileId;
      const profile = definitiveSchemaProfile(expectedProfileId);
      const verifyRuntimeSchemaForProfile = bindVerifier(expectedProfileId);
      const forwarded = { ...options };
      delete forwarded.expectedProfileId;
      if (
        forwarded.dependencies !== undefined && (
          !forwarded.dependencies ||
          Object.getPrototypeOf(forwarded.dependencies) !== Object.prototype ||
          Object.hasOwn(forwarded.dependencies, "createSocialRepository")
        )
      ) {
        fail("linux_gate_restore_behavior_repository_dependency_invalid");
      }
      const createSocialRepositoryForProfile =
        createProfileAwareSocialRepositoryFactory({
          expectedProfile: profile,
          currentCreateSocialRepository,
          legacyCreateSocialRepository: legacy.createSocialRepository
        });
      return restoreBehavior.createRestoreBehaviorVerifiers({
        ...forwarded,
        legacy2ARoot,
        dependencies: {
          ...(forwarded.dependencies || {}),
          verifyRuntimeSchema: verifyRuntimeSchemaForProfile,
          createSocialRepository: createSocialRepositoryForProfile
        },
        legacyDependencies: profileBoundLegacyDependencies(
          verifyRuntimeSchemaForProfile
        )
      });
    },
    verifyRuntimeSchemaForProfile(request) {
      if (
        !request ||
        Object.getPrototypeOf(request) !== Object.prototype ||
        JSON.stringify(Object.keys(request).sort()) !==
          JSON.stringify(["expectedProfileId", "pool", "role"])
      ) {
        fail("linux_gate_schema_profile_verifier_request_invalid");
      }
      return bindVerifier(request.expectedProfileId)(request.pool, request.role);
    },
    schemaProfileDiagnostics() {
      return diagnostics;
    }
  });
}

async function materializeLegacy2ASource({ repositoryRoot, destination, runCommand }) {
  const manifest = require("../src/persistence/postgres/legacy-2a-source-manifest.json");
  const files = Object.keys(manifest.files || {}).sort();
  if (
    manifest.commit !== LEGACY_2A_COMMIT || files.length < 1 ||
    files.some((relative) => !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(relative) || relative.includes("..")) ||
    fs.existsSync(destination)
  ) fail("linux_gate_legacy_source_contract_invalid");
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  try {
    for (const relative of files) {
      const target = path.join(destination, ...relative.split("/"));
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const result = await runCommand("git", ["show", `${LEGACY_2A_COMMIT}:${relative}`], {
        timeoutMs: 30_000,
        cwd: repositoryRoot,
        failureCode: "linux_gate_legacy_source_materialization_failed"
      });
      fs.writeFileSync(target, result.stdout, { flag: "wx", mode: 0o600 });
    }
    const dependencies = path.join(repositoryRoot, "node_modules");
    if (!fs.statSync(dependencies).isDirectory()) fail("linux_gate_legacy_dependencies_missing");
    fs.symlinkSync(dependencies, path.join(destination, "node_modules"), "dir");
    const provenance = require("../src/persistence/postgres/restore-behavior-verifiers")
      .verifyLegacy2ASourceManifest(destination);
    if (provenance.commit !== LEGACY_2A_COMMIT || provenance.files !== files.length) {
      fail("linux_gate_legacy_source_identity_invalid");
    }
    return destination;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function proveMigrationManifestTamper(migrations, state) {
  const root = fs.mkdtempSync(path.join(state.workDirectory, "migration-checksum-tamper-"));
  let refused = false;
  try {
    const source = path.join(state.repositoryRoot, "db", "migrations");
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "checksums.json"), "utf8"));
    for (const entry of manifest.migrations) {
      fs.copyFileSync(path.join(source, entry.file), path.join(root, entry.file), fs.constants.COPYFILE_EXCL);
    }
    const last = manifest.migrations.at(-1);
    last.sha256 = `${last.sha256[0] === "0" ? "1" : "0"}${last.sha256.slice(1)}`;
    fs.writeFileSync(path.join(root, "checksums.json"), `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    try {
      migrations.readManifest({ migrationsDirectory: root, manifestPath: path.join(root, "checksums.json") });
    } catch (error) {
      refused = error?.code === "migration_checksum_mismatch";
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: false, maxRetries: 0 });
  }
  if (!refused || fs.existsSync(root)) fail("linux_gate_migration_checksum_tamper_not_refused");
  return true;
}

async function migrationEvidence(state, dependencies = {}) {
  const migrations = dependencies.migrations || require("../src/persistence/postgres/migrations");
  const withTransaction = dependencies.withTransaction || require("../src/persistence/postgres/pool").withTransaction;
  const target = {
    approval: migrations.APPLY_APPROVAL,
    productionApproval: "not-applicable-local-harness",
    environment: "local",
    environmentId: state.environmentId,
    host: LOOPBACK,
    port: String(state.target.port),
    database: DATABASE,
    username: MIGRATION_LOGIN
  };
  const runner = dependencies.migrationRunner || migrations.createMigrationRunner({
    pool: state.pools.migration,
    ownerRole: OWNER_ROLE,
    migratorRole: MIGRATOR_ROLE,
    target,
    manifestOptions: { root: state.repositoryRoot }
  });
  const reapplied = await runner.apply({ SOCIAL_MIGRATION_TARGET_FINGERPRINT: migrations.targetFingerprint(target) });
  const revalidated = await runner.validate();
  if (reapplied.length !== 0 || revalidated.valid !== true || revalidated.applied !== 4 || revalidated.pending !== 0) {
    fail("linux_gate_migration_reapply_invalid");
  }
  const checksumTamperRefused = (dependencies.proveTamper || proveMigrationManifestTamper)(migrations, state);
  return Promise.all([
    withTransaction(state.pools.migration, (client) => client.query([
      "SELECT version,checksum_sha256 AS checksum FROM ia4tube_migrations.schema_migrations ORDER BY version"
    ].join("\n")), { role: MIGRATOR_ROLE }),
    withTransaction(state.pools.migration, (client) => client.query([
      "SELECT",
      " to_regclass('ia4tube_social.social_idempotency_operations') IS NOT NULL AS idempotency,",
      " to_regclass('ia4tube_social.social_publications') IS NOT NULL AS publications,",
      " to_regclass('ia4tube_social.social_publication_attempts') IS NOT NULL AS attempts,",
      " (SELECT COUNT(*)::integer FROM pg_catalog.pg_indexes WHERE schemaname='ia4tube_social') AS indexes,",
      " (SELECT COUNT(*)::integer FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='ia4tube_social') AS constraints,",
      " (SELECT COUNT(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ia4tube_social' AND c.relkind IN('r','p') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) AS rls_missing"
    ].join("\n")), { role: OWNER_ROLE })
  ]).then(([ledger, catalog]) => {
    const manifest = migrations.readManifest({ root: state.repositoryRoot });
    const expected = manifest.map((item) => ({ version: item.version, checksum: item.sha256 }));
    const actual = ledger.rows.map((item) => ({ version: item.version, checksum: item.checksum }));
    const row = catalog.rows?.[0];
    if (
      JSON.stringify(actual) !== JSON.stringify(expected) ||
      !row?.idempotency || !row?.publications || !row?.attempts ||
      Number(row.indexes) < 1 || Number(row.constraints) < 1 || Number(row.rls_missing) !== 0
    ) fail("linux_gate_migration_catalog_invalid");
    return Object.freeze({
      applied: actual.length,
      ledgerSha256: crypto.createHash("sha256").update(canonicalJson(actual)).digest("hex"),
      migration0004Checksum: actual.at(-1).checksum,
      requiredTablesPresent: true,
      indexes: Number(row.indexes),
      constraints: Number(row.constraints),
      rlsAndForceRls: true,
      checksumTamperRefused,
      idempotentReapply: true,
      controlledFailureRolledBack: true,
      restoredTo0003AndReapplied0004: true
    });
  });
}

function createPhaseRunner(evidence) {
  return async function phase(name, operation, options = {}) {
    if (!SAFE_PHASE.has(name)) fail("linux_gate_phase_invalid");
    if (evidence.firstFailure) fail("linux_gate_phase_after_failure_refused");
    if (
      !options || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some((key) => key !== "classifyFailure") ||
      (options.classifyFailure !== undefined && typeof options.classifyFailure !== "function")
    ) fail("linux_gate_phase_options_invalid");
    const started = Date.now();
    try {
      const result = await operation();
      evidence.phases.push({ name, status: "passed", durationMs: Date.now() - started, result });
      return result;
    } catch (error) {
      const code = options.classifyFailure === undefined
        ? failureCode(error)
        : options.classifyFailure();
      if (typeof code !== "string" || !SAFE_FAILURE.test(code)) {
        fail("linux_gate_phase_failure_code_invalid");
      }
      evidence.firstFailure = { phase: name, code };
      const failedPhase = { name, status: "failed", durationMs: Date.now() - started, code };
      if (name === "postgres") {
        const diagnostics = postgresFailureDiagnostics(error);
        if (diagnostics) failedPhase.diagnostics = diagnostics;
      }
      evidence.phases.push(failedPhase);
      throw error;
    }
  };
}

async function runLinuxGate(options = {}) {
  const gateEnvironment = options.environment === undefined
    ? process.env
    : options.environment;
  if (
    !gateEnvironment || typeof gateEnvironment !== "object" ||
    gateEnvironment.POSTGRES_BACKUP_CONNECTIVITY_MODE !== BACKUP_CONNECTIVITY_MODE
  ) {
    fail("linux_gate_backup_connectivity_mode_invalid");
  }
  const runnerTemp = path.resolve(options.runnerTemp || process.env.RUNNER_TEMP || "");
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, ".."));
  const runIdSource = options.runId || process.env.GITHUB_RUN_ID;
  const runId = `linux-${String(runIdSource || "").replace(/[^0-9]/g, "").slice(0, 30)}`;
  if (!/^linux-[0-9]{1,30}$/.test(runId)) fail("linux_gate_run_id_invalid");
  const evidenceDirectory = exactDirectory(
    options.evidenceDirectory || process.env.SOCIAL_3A0P_EVIDENCE_DIR || path.join(runnerTemp, "social-3a0p-linux-gate-evidence"),
    runnerTemp,
    "linux_gate_evidence_directory_invalid"
  );
  const evidencePath = path.join(evidenceDirectory, EVIDENCE_FILE);
  const hashPath = path.join(evidenceDirectory, EVIDENCE_HASH_FILE);
  const markerPath = options.sanitizationMarker || process.env.SOCIAL_3A0P_SANITIZATION_MARKER || path.join(evidenceDirectory, SANITIZED_MARKER);
  if (path.resolve(markerPath) !== path.resolve(path.join(evidenceDirectory, SANITIZED_MARKER))) fail("linux_gate_sanitization_marker_invalid");
  if (process.platform !== "linux" && options.allowNonLinux !== true) fail("linux_gate_linux_required");
  if (fs.existsSync(evidenceDirectory)) fail("linux_gate_evidence_collision");
  fs.mkdirSync(evidenceDirectory, { recursive: false, mode: 0o700 });
  const backupRestoreProvenance = createBackupRestoreProvenanceTracker({
    requireSpawnProof: options.runCommand === undefined
  });
  const rlsFailureProvenance = createRlsFailureProvenanceTracker();
  const gate3FailureProvenance = createGate3FailureProvenanceTracker();
  const gate4FailureProvenance = createGate4FailureProvenanceTracker();
  const gate4ConnectionCapacityDiagnostics =
    createGate4ConnectionCapacityDiagnosticsRecorder();
  const runCommand = options.runCommand || commandRunner({
    spawnImpl: backupRestoreProvenance.wrapSpawn(spawn)
  });
  const poolMetrics = createPoolMetricsRegistry();
  const postgres = (options.createPostgres || createLinuxPostgres)({
    runnerTemp,
    runId,
    PoolClass: options.PoolClass || require("pg").Pool,
    metricsRegistry: poolMetrics,
    runCommand,
    randomBytes: options.randomBytes
  });
  const evidence = {
    format: 1,
    kind: "ia4tube-social-3a0p-linux-physical-gates",
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    productCommit: PRODUCT_COMMIT,
    imageDigest: IMAGE_DIGEST,
    status: "running",
    phases: [],
    firstFailure: null,
    backupRestoreFailureProvenance: null,
    gate3FailureProvenance: null,
    gate4FailureProvenance: null,
    gate4ConnectionCapacityDiagnostics: null,
    rlsFailureProvenance: null,
    cleanupFailure: null
  };
  let publishedEvidence = evidence;
  const phase = createPhaseRunner(evidence);
  const sensitiveMarkers = [
    postgres.materials.admin.toString("utf8"),
    postgres.materials.provisioner.toString("utf8"),
    postgres.materials.migration.toString("utf8"),
    postgres.materials.runtime.toString("utf8")
  ];
  let state;
  let plans;
  let profile0003Plans;
  let gates;
  let legacy2ARoot;
  let restoreBehaviorFacade;
  let cleanupResult = null;
  let operationalFailure = null;
  let activePhase = "platform";
  let freeInitial = freeBytes(runnerTemp);
  let freeMinimum = freeInitial;
  let diskMonitorFailure = false;
  const recordCleanupFailure = (error) => {
    const code = failureCode(error);
    if (!evidence.cleanupFailure) evidence.cleanupFailure = code;
    if (!evidence.firstFailure) evidence.firstFailure = { phase: "cleanup", code };
    return code;
  };
  const sampleSpace = () => {
    try { freeMinimum = Math.min(freeMinimum, freeBytes(runnerTemp)); } catch { diskMonitorFailure = true; }
  };
  const diskMonitor = setInterval(sampleSpace, 500);
  diskMonitor.unref?.();
  try {
    evidence.platform = await publicPlatformEvidence(runnerTemp, runCommand);
    activePhase = "durability";
    await phase("durability", () => (options.runDurability || runLinuxDurabilityProof)({ runnerTemp }));
    sampleSpace();
    activePhase = "postgres";
    let adaptPlanPoolOptions;
    const postgresEvidence = await phase("postgres", async () => {
      const started = await postgres.start();
      if (postgres.port !== LOGICAL_DATABASE_PORT) fail("linux_gate_private_database_port_invalid");
      adaptPlanPoolOptions = createPrivatePlanPoolOptionsAdapter(postgres);
      return started;
    });
    sampleSpace();
    const environmentId = crypto.randomUUID();
    let bootstrap;
    let bootstrapEvidence;
    activePhase = "bootstrap";
    await phase("bootstrap", async () => {
      bootstrap = await postgres.bootstrap(repositoryRoot, environmentId);
      bootstrapEvidence = publicBootstrapEvidence(bootstrap);
      return bootstrapEvidence;
    });
    activePhase = "gate_setup";
    legacy2ARoot = await materializeLegacy2ASource({
      repositoryRoot,
      destination: path.join(postgres.runRoot, "legacy-2a-source"),
      runCommand
    });
    restoreBehaviorFacade = createRestoreBehaviorFacade(legacy2ARoot);
    state = {
      target: { host: LOOPBACK, port: LOGICAL_DATABASE_PORT },
      environmentId,
      repositoryRoot,
      workDirectory: postgres.workDirectory,
      materials: postgres.materials,
      pools: bootstrap.pools,
      PoolClass: postgres.InstrumentedPool,
      database: DATABASE,
      passwords: {
        [MIGRATION_LOGIN]: postgres.materials.migration.toString("utf8"),
        [RUNTIME_LOGIN]: postgres.materials.runtime.toString("utf8")
      }
    };
    const runMarker = `${RUN_MARKER_PREFIX}${crypto.createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
    const localBackup = require("./social-3a0p-local-backup-restore");
    const backupProduct = require("../src/persistence/postgres/backup-restore");
    let directoryFsyncBundles = 0;
    const linuxProfileBackup = createLinuxProfileBackupRunner({
      localBackup,
      backupProduct,
      backupRestoreProvenance,
      recordDirectoryFsync() {
        directoryFsyncBundles += 1;
      }
    });
    const linuxProfileRestore = createLinuxProfileRestoreRunner({
      localBackup,
      backupRestoreProvenance
    });
    const PhysicalPlanPool = createRoleScopedPlanPoolClass(
      postgres.InstrumentedPool,
      require("../src/persistence/postgres/pool").withTransaction,
      (database) => postgres.makePool(
        database,
        MIGRATION_LOGIN,
        postgres.materials.migration,
        1,
        "ia4tube-social-3a0p-migration"
      ),
      prepareLinuxRestoreTarget,
      adaptPlanPoolOptions
    );
    state.PoolClass = PhysicalPlanPool;
    const physicalRunTool = createDrainAwareRunTool(
      PhysicalPlanPool,
      postgres.createRunTool()
    );
    const windowsPlans = require("./social-3a0p-local-windows-physical-plans").createWindowsPhysicalPlans({
      approval: localBackup.LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      target: state.target,
      state,
      paths: { ownedRoot: postgres.workDirectory },
      executables: { psql: "/usr/bin/psql", pgDump: "/usr/bin/pg_dump", pgRestore: "/usr/bin/pg_restore" },
      PoolClass: PhysicalPlanPool,
      repositoryRoot,
      randomBytes: options.randomBytes || crypto.randomBytes,
      dependencies: {
        backup: createLinuxRestoreConfigFacade({
          backupProduct,
          backupDirectory: path.join(postgres.workDirectory, "backups")
        }),
        createLoginCredentialVerifierBridge({ database, configuration }) {
          if (configuration?.target?.database !== database) {
            fail("linux_gate_login_verifier_database_invalid");
          }
          return createVerifiedLoginCredentialPoolBridge(postgres, {
            target: { host: LOOPBACK, port: LOGICAL_DATABASE_PORT },
            database,
            provisionerLogin: PROVISIONER_LOGIN,
            migrationLogin: MIGRATION_LOGIN,
            runtimeLogin: RUNTIME_LOGIN,
            passwords: {
              [PROVISIONER_LOGIN]: postgres.materials.provisioner.toString("utf8"),
              [MIGRATION_LOGIN]: postgres.materials.migration.toString("utf8"),
              [RUNTIME_LOGIN]: postgres.materials.runtime.toString("utf8")
            }
          }, { environment: gateEnvironment });
        },
        createBackupTransportBridge(contract) {
          return createBackupTransportBridge(postgres, physicalRunTool, contract);
        },
        backupRestoreProvenance: Object.freeze({
          bindBackup: backupRestoreProvenance.bindBackup,
          bindRestore: backupRestoreProvenance.bindRestore,
          runBackup: backupRestoreProvenance.runBackup,
          runRestore: backupRestoreProvenance.runRestore
        }),
        runTool: physicalRunTool,
        restoreBehavior: restoreBehaviorFacade
      }
    });
    const gate1MigrationPools = createGate1MigrationPoolLifecycle({
      plans: windowsPlans,
      state,
      createMigrationPool: () => postgres.makePool(
        DATABASE,
        MIGRATION_LOGIN,
        postgres.materials.migration,
        2,
        "ia4tube-social-3a0p-migration"
      )
    });
    profile0003Plans = createLinuxProfile0003PlansFacade({
      plans: gate1MigrationPools.plans,
      makeMigrationPool: (database) => postgres.makePool(
        database,
        MIGRATION_LOGIN,
        postgres.materials.migration,
        1,
        "ia4tube-social-3a0p-migration"
      ),
      randomUUID: options.randomUUID || crypto.randomUUID
    });
    plans = profile0003Plans.plans;
    gates = require("./social-3a0p-local-connector-physical-gates").createConnectorPhysicalGates({
      plans,
      randomBytes: options.randomBytes || crypto.randomBytes,
      dependencies: {
        runGate3Substep: gate3FailureProvenance.forOperation("base"),
        runGate4Substep: gate4FailureProvenance.forOperation("base"),
        runProfileBackup: linuxProfileBackup,
        runProfileRestore: linuxProfileRestore
      }
    });
    gates.assertConfigured();
    activePhase = "migrations";
    await phase("migrations", async () => {
      const base = await gates.migration({ state });
      await gate1MigrationPools.recreateMigrationPoolForEvidence();
      const catalog = await migrationEvidence(state);
      return Object.freeze({ ...base, ...catalog });
    });
    sampleSpace();
    activePhase = "rls_privilege_inventory_context_reproduction";
    const inventoryContextReproduction = await phase(
      "rls_privilege_inventory_context_reproduction",
      () => runRlsPrivilegeInventoryContextPhase({
        state,
        runSubstep: rlsFailureProvenance.runSubstep
      })
    );
    const rlsRuntimeWriteContract = createRlsRuntimeWriteContractOrchestrator({
      state,
      gates,
      inventoryContextReproduction,
      runSubstep: rlsFailureProvenance.runSubstep
    });
    activePhase = "rls_runtime_write_contract_reproduction";
    await phase(
      "rls_runtime_write_contract_reproduction",
      () => rlsRuntimeWriteContract.reproduce()
    );
    activePhase = "rls_runtime_attributes_text_resolution_reproduction";
    const runtimeAttributesTextResolutionReproduction = await phase(
      "rls_runtime_attributes_text_resolution_reproduction",
      () => runRlsRuntimeAttributesTextResolutionPhase({
        state,
        runSubstep: rlsFailureProvenance.runSubstep
      })
    );
    activePhase = "rls_roles";
    await phase(
      "rls_roles",
      () => rlsRuntimeWriteContract.correct(
        runtimeAttributesTextResolutionReproduction
      )
    );
    activePhase = "concurrency_oauth_idempotency";
    await phase("concurrency_oauth_idempotency", async () => {
      const base = await gates.concurrency({ state });
      const supplement = await runConcurrencyOAuthIdempotencyGate(
        state,
        sensitiveMarkers,
        Object.freeze({
          runGate3Substep: gate3FailureProvenance.forOperation("supplemental")
        })
      );
      return Object.freeze({ ...base, ...supplement });
    });
    activePhase = "vault";
    await phase("vault", async () => {
      const base = await gates.vault({ state });
      const supplement = await runVaultSupplementalGate(
        state,
        sensitiveMarkers,
        Object.freeze({
          runGate4Substep: gate4FailureProvenance.forOperation("supplemental")
        })
      );
      const persisted = await runPersistedVaultGate(
        state,
        sensitiveMarkers,
        legacy2ARoot,
        Object.freeze({
          runGate4Substep: gate4FailureProvenance.forOperation("persisted"),
          recordGate4ConnectionCapacityDiagnostics:
            gate4ConnectionCapacityDiagnostics.record,
          retirePrimaryMigrationPoolBeforePersistedVault: async () => {
            const proof = await retirePrimaryMigrationPoolBeforePersistedVault(state);
            const keys = [
              "allMigrationClientsIdleBeforeRetirement",
              "migrationPoolEndCalls",
              "migrationPoolRetired",
              "runtimePoolPreserved",
              "waitingCountBeforeRetirement"
            ];
            if (
              !proof || Object.getPrototypeOf(proof) !== Object.prototype ||
              !Object.isFrozen(proof) ||
              JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(keys) ||
              proof.migrationPoolRetired !== true || proof.migrationPoolEndCalls !== 1 ||
              proof.runtimePoolPreserved !== true || proof.waitingCountBeforeRetirement !== 0 ||
              proof.allMigrationClientsIdleBeforeRetirement !== true
            ) {
              fail("linux_gate_primary_migration_pool_handoff_proof_invalid");
            }
            return true;
          }
        })
      );
      gate4FailureProvenance.requireComplete();
      return Object.freeze({ ...base, ...supplement, ...persisted });
    }, Object.freeze({
      classifyFailure() {
        return gate4FailureProvenance.failure()?.causalCode ||
          "gate4_failure_provenance_unobserved";
      }
    }));
    activePhase = "backup_restore";
    await phase("backup_restore", async () => {
      await retirePrimaryPoolsBeforeBackup(state);
      const result = await gates.backupRestore({ state });
      if (directoryFsyncBundles !== 2) fail("linux_gate_bundle_directory_fsync_count_invalid");
      const backupTransport = publicBackupTransportEvidence(postgres);
      if (
        backupTransport.logicalIdentityTlsContractValidated !== true ||
        backupTransport.physicalDisposableTransportValidated !== true ||
        backupTransport.productionTlsPhysicallyTestedInThisGate !== false ||
        backupTransport.productionTlsPreviouslyProvedBySocial2B !== true ||
        backupTransport.localTlsDisabledOnlyInsideOwnedContainer !== true ||
        backupTransport.pgDumpStarted !== true ||
        backupTransport.pgDumpSucceeded !== true ||
        backupTransport.pgRestoreStarted !== true ||
        backupTransport.pgRestoreSucceeded !== true
      ) {
        fail("linux_gate_backup_transport_evidence_invalid");
      }
      return Object.freeze({
        ...result,
        ...profile0003Plans.evidence(),
        ...backupTransport,
        bundleDirectoryFsyncConfirmed: true,
        bundleDirectoryFsyncCount: directoryFsyncBundles
      });
    });
    sampleSpace();
    activePhase = "plan_cleanup";
    await gates.destroy();
    gates = null;
    plans = null;
    await PhysicalPlanPool.closeAll();
    activePhase = "metrics";
    await phase("metrics", async () => {
      const admin = postgres.makePool("postgres", "ia4tube_social_local_admin", postgres.materials.admin, 1, "ia4tube-social-3a0p-administration");
      try {
        const sessions = await postgres.sessionRows(admin);
        const expectedSessions = new Map([
          [RUNTIME_LOGIN, Object.freeze({ category: "runtime", applicationName: "ia4tube-social-3a0p-runtime" })],
          [MIGRATION_LOGIN, Object.freeze({ category: "migration", applicationName: "ia4tube-social-3a0p-migration" })]
        ]);
        const ownedSessions = sessions.map((item) => {
          const expected = expectedSessions.get(item.role);
          if (!expected || item.applicationName !== expected.applicationName) fail("linux_gate_orphan_session_detected");
          return { pid: item.pid, category: expected.category, applicationName: expected.applicationName };
        });
        const sessionMetrics = collectSessionMetrics({
          sessions,
          roleCategories: {
            runtime: [RUNTIME_LOGIN],
            migration: [MIGRATION_LOGIN],
            provisioning: [PROVISIONER_LOGIN]
          },
          ownedSessions
        });
        assertSessionMetricsSafe(sessionMetrics);
        const poolEvidence = poolMetrics.snapshot();
        for (const pool of Object.values(state.pools)) {
          await createPhysicalPoolDrainTracker(pool).end(() => pool.end());
        }
        state.pools = {};
        const orphanSessionsAfterPoolClose = await postgres.orphanSessionCount(admin);
        if (orphanSessionsAfterPoolClose !== 0) fail("linux_gate_orphan_session_after_close");
        if (diskMonitorFailure) fail("linux_gate_disk_monitor_failed");
        return Object.freeze({
          pool: poolEvidence,
          sessions: sessionMetrics,
          runtimePoolConfiguredMax: bootstrapEvidence.runtimePoolConfiguredMax,
          orphanSessionsAfterPoolClose,
          orphanConnectionsZero: true,
          disk: {
            initialFreeBytes: freeInitial,
            minimumFreeBytes: freeMinimum,
            finalBeforeCleanupFreeBytes: freeBytes(runnerTemp)
          },
          postgres: postgresEvidence
        });
      } finally {
        await createPhysicalPoolDrainTracker(admin).end(() => admin.end());
      }
    });
    activePhase = "secret_scan";
    await phase("secret_scan", async () => {
      const scan = containsMarkerInTree(postgres.workDirectory, sensitiveMarkers);
      if (scan.present) fail("linux_gate_plaintext_found_in_files");
      const dataScan = await postgres.scanDataDirectoryMarkers(sensitiveMarkers);
      if (dataScan.markersPresent) fail("linux_gate_plaintext_found_in_pgdata");
      return Object.freeze({
        exactSyntheticMarkersAbsent: true,
        postgresDataMarkersAbsent: true,
        filesScanned: scan.filesScanned,
        bytesScanned: scan.bytesScanned,
        rawPostgresLogsAbsent: true,
        rawSqlAbsentFromEvidence: true
      });
    });
    evidence.status = "passed";
  } catch (error) {
    operationalFailure = error;
    evidence.status = "failed";
    let code = activePhase === "vault"
      ? "gate4_failure_provenance_unobserved"
      : failureCode(error);
    if (activePhase === "vault") {
      try {
        const observedFailure = gate4FailureProvenance.requireFailure();
        code = observedFailure.causalCode;
        evidence.firstFailure = { phase: "vault", code };
        const failedVaultPhase = evidence.phases.find((entry) => (
          entry?.name === "vault" && entry?.status === "failed"
        ));
        if (failedVaultPhase) failedVaultPhase.code = code;
      } catch (provenanceError) {
        code = "gate4_failure_provenance_unobserved";
        operationalFailure = provenanceError;
        evidence.firstFailure = { phase: "vault", code };
        const failedVaultPhase = evidence.phases.find((entry) => (
          entry?.name === "vault" && entry?.status === "failed"
        ));
        if (failedVaultPhase) failedVaultPhase.code = code;
      }
    }
    if (code === "backup_external_tool_failed" && !backupRestoreProvenance.failure()) {
      backupRestoreProvenance.captureUnobservedFailure();
    }
    evidence.backupRestoreFailureProvenance =
      backupRestoreProvenance.failure();
    evidence.gate3FailureProvenance = gate3FailureProvenance.failure();
    evidence.gate4FailureProvenance = gate4FailureProvenance.failure();
    evidence.gate4ConnectionCapacityDiagnostics =
      gate4ConnectionCapacityDiagnostics.forFailure(
        evidence.gate4FailureProvenance
      );
    evidence.rlsFailureProvenance = rlsFailureProvenance.failure();
    if (!evidence.firstFailure) evidence.firstFailure = { phase: activePhase, code };
  } finally {
    clearInterval(diskMonitor);
    sampleSpace();
    try { await gates?.destroy?.(); } catch (error) {
      recordCleanupFailure(error);
    }
    try { await plans?.destroy?.(); } catch (error) {
      recordCleanupFailure(error);
    }
    if (state?.pools) {
      for (const pool of Object.values(state.pools)) {
        try {
          await createPhysicalPoolDrainTracker(pool).end(() => pool.end());
        } catch (error) {
          recordCleanupFailure(error);
        }
      }
    }
    const cleanupStarted = Date.now();
    try {
      cleanupResult = await postgres.cleanup();
      evidence.phases.push({ name: "cleanup", status: "passed", durationMs: Date.now() - cleanupStarted, result: cleanupResult });
    } catch (error) {
      const code = recordCleanupFailure(error);
      evidence.phases.push({ name: "cleanup", status: "failed", durationMs: Date.now() - cleanupStarted, code });
    }
    const failedPostgresPhase = evidence.phases.find((entry) => (
      entry?.name === "postgres" && entry?.status === "failed" && entry?.diagnostics
    ));
    if (failedPostgresPhase) {
      failedPostgresPhase.diagnostics = Object.freeze({
        ...failedPostgresPhase.diagnostics,
        cleanupCompleted: cleanupResult?.cleanupCompleted === true
      });
    }
    evidence.backupTransport = publicBackupTransportEvidence(postgres);
    evidence.gate3FailureProvenance = gate3FailureProvenance.failure();
    evidence.gate4FailureProvenance = gate4FailureProvenance.failure();
    evidence.gate4ConnectionCapacityDiagnostics =
      gate4ConnectionCapacityDiagnostics.forFailure(
        evidence.gate4FailureProvenance
      );
    evidence.schemaProfileDiagnostics =
      restoreBehaviorFacade?.schemaProfileDiagnostics() || null;
    evidence.cleanup = cleanupResult || { cleanupCompleted: false };
    evidence.diskFinalFreeBytes = freeBytes(runnerTemp);
    evidence.status = evidence.status === "passed" && cleanupResult?.cleanupCompleted === true && !evidence.cleanupFailure
      ? "passed"
      : "failed";
    if (state?.passwords) {
      state.passwords[MIGRATION_LOGIN] = "";
      state.passwords[RUNTIME_LOGIN] = "";
    }
    if (!evidenceSafe(evidence)) {
      operationalFailure = operationalFailure || new LinuxGateFailure("linux_evidence_sanitization_failed");
      evidence.status = "failed";
      if (!evidence.firstFailure) evidence.firstFailure = { phase: "secret_scan", code: "linux_evidence_sanitization_failed" };
      publishedEvidence = sanitizedFailureEvidence(evidence);
    } else {
      publishedEvidence = evidence;
    }
    let serialized = `${canonicalJson(publishedEvidence)}\n`;
    if (sensitiveMarkers.some((marker) => typeof marker === "string" && marker.length >= 16 && serialized.includes(marker))) {
      operationalFailure = operationalFailure || new LinuxGateFailure("linux_evidence_secret_scan_failed");
      if (!evidence.firstFailure) evidence.firstFailure = { phase: "secret_scan", code: "linux_evidence_secret_scan_failed" };
      publishedEvidence = sanitizedFailureEvidence(evidence, "linux_evidence_secret_scan_failed");
      serialized = `${canonicalJson(publishedEvidence)}\n`;
    }
    if (!evidenceSafe(publishedEvidence) || sensitiveMarkers.some((marker) => (
      typeof marker === "string" && marker.length >= 16 && serialized.includes(marker)
    ))) fail("linux_evidence_sanitized_fallback_invalid");
    const digest = crypto.createHash("sha256").update(serialized).digest("hex");
    fs.writeFileSync(evidencePath, serialized, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(hashPath, `${digest}  ${EVIDENCE_FILE}\n`, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(markerPath, "sanitized-approved\n", { flag: "wx", mode: 0o600 });
    for (let index = 0; index < sensitiveMarkers.length; index += 1) sensitiveMarkers[index] = "";
  }
  const digest = fs.readFileSync(hashPath, "utf8").slice(0, 64);
  const ok = publishedEvidence.status === "passed" && fs.existsSync(markerPath) && !operationalFailure;
  return Object.freeze({
    ok,
    status: publishedEvidence.status,
    evidenceSha256: digest,
    firstFailure: publishedEvidence.firstFailure
  });
}

async function cleanupOnly(options = {}) {
  const runnerTemp = path.resolve(options.runnerTemp || process.env.RUNNER_TEMP || "");
  const runId = `linux-${String(options.runId || process.env.GITHUB_RUN_ID || "").replace(/[^0-9]/g, "").slice(0, 30)}`;
  if (!/^linux-[0-9]{1,30}$/.test(runId)) fail("linux_gate_run_id_invalid");
  const registry = createPoolMetricsRegistry();
  const postgres = createLinuxPostgres({ runnerTemp, runId, PoolClass: require("pg").Pool, metricsRegistry: registry });
  await postgres.cleanup();
  const evidenceDirectory = exactDirectory(
    options.evidenceDirectory || process.env.SOCIAL_3A0P_EVIDENCE_DIR || path.join(runnerTemp, "social-3a0p-linux-gate-evidence"),
    runnerTemp,
    "linux_gate_evidence_directory_invalid"
  );
  if (fs.existsSync(evidenceDirectory)) fs.rmSync(evidenceDirectory, { recursive: true, force: false, maxRetries: 0 });
  return Object.freeze({ cleanupCompleted: !fs.existsSync(evidenceDirectory) });
}

async function main() {
  const argument = process.argv.slice(2);
  if (
    argument.length !== 1 ||
    !new Set(["--run", "--supervise-run", "--cleanup"]).has(argument[0])
  ) fail("linux_gate_cli_invalid");
  if (argument[0] === "--cleanup") {
    const result = await cleanupOnly();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (argument[0] === "--supervise-run") {
    const supervised = await runGateProcessSupervisor();
    if (supervised.workflowExitCode !== 0) process.exitCode = 1;
    return;
  }
  const result = await runLinuxGate();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${failureCode(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BASE_COMMIT,
  BRANCH,
  EVIDENCE_FILE,
  EVIDENCE_HASH_FILE,
  GATE_PROCESS_STATUS_FILE,
  GATE_PROCESS_STATUS_HASH_FILE,
  LinuxGateFailure,
  MARKER,
  PRODUCT_COMMIT,
  SANITIZED_MARKER,
  canonicalJson,
  cleanupOnly,
  containsMarkerInTree,
  classifyGate4ConnectionCapacityDiagnostics,
  createBackupRestoreProvenanceTracker,
  createDrainAwareRunTool,
  createBackupTransportBridge,
  createGate1MigrationPoolLifecycle,
  createGate3FailureProvenanceTracker,
  createGate4ConnectionCapacityDiagnostics,
  createGate4ConnectionCapacityDiagnosticsRecorder,
  createGate4FailureProvenanceTracker,
  createLinuxProfile0003PlansFacade,
  createLinuxProfileBackupRunner,
  createLinuxProfileRestoreRunner,
  createLinuxRestoreConfigFacade,
  createPhaseRunner,
  createPhysicalPoolDrainTracker,
  createPrivatePlanPoolOptionsAdapter,
  createRlsFailureProvenanceTracker,
  createRlsRuntimeWriteContractOrchestrator,
  createRestoreBehaviorFacade,
  createRoleScopedPlanPoolClass,
  createVerifiedLoginCredentialPoolBridge,
  evidenceSafe,
  failureCode,
  freeBytes,
  gate3FailureCode,
  gate4FailureCode,
  gateProcessStatusFromChildResult,
  isLinuxRestoreDatabase,
  isRestoreEmptyTargetInventoryQuery,
  materializeLegacy2ASource,
  migrationEvidence,
  prepareLinuxRestoreTarget,
  profile0003Snapshot,
  proveMigrationManifestTamper,
  publicPlatformEvidence,
  publicBootstrapEvidence,
  publicBackupTransportEvidence,
  publicRlsPrivilegeInventoryContextReproductionEvidence,
  publicRlsRoleGateEvidence,
  publicRlsRuntimeAttributesTextResolutionReproductionEvidence,
  publicRlsRuntimeWriteContractReproductionEvidence,
  retirePrimaryMigrationPoolBeforePersistedVault,
  retirePrimaryPoolsBeforeBackup,
  rlsFailureCode,
  sanitizedBackupRestoreFailureProvenance,
  sanitizedFailureEvidence,
  sanitizedGate3FailureProvenance,
  sanitizedGate4ConnectionCapacityDiagnostics,
  sanitizedGate4FailureProvenance,
  sanitizedGateProcessStatus,
  sanitizedRlsFailureProvenance,
  runRlsPrivilegeInventoryContextPhase,
  runRlsRuntimeAttributesTextResolutionPhase,
  runGateProcessSupervisor,
  runLinuxGate,
  writeGateProcessStatus
};
