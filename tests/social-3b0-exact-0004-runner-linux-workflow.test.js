"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { TextDecoder } = require("node:util");

const ROOT = path.resolve(__dirname, "..");
const RELATIVE = ".github/workflows/social-3b0-exact-0004-runner-linux.yml";
const FILE = path.join(ROOT, ...RELATIVE.split("/"));
const BRANCH =
  "social/checkpoint-3b0-exact-0004-runner-linux-force-rls-conflict-gate-20260820";
const BASE = "13e38b875db2a220514fe06113663c517c975592";
const PARENT = "1de14105800db3ad024e15700d7e23fb2b41282c";
const PLAN_SUBPHASE_PARENT = "73433e1b2d856e073db452ebe17815bec296bba0";
const SOURCE_COMMIT = "8534817574a22dbd144a835c9f3585c44ee11c96";
const MESSAGE =
  "[run-social-3b0] make exact 0004 conflict gate RLS independent";
const IMAGE =
  "docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const RUNNER_FILE = "scripts/run-real-postgres-tests.js";
const RUNNER_MODULE = "./scripts/run-real-postgres-tests";
const RUNNER_LF_SHA256 =
  "35d6ca544868957e44fa1787dfef6c3967ebf106e277877b70f9fae15e2e67bd";
const RUNNER_FILTERED_OID = "a62d4607bf60345e05c1b42a5dfccd221950b227";
const PARENT_RUNNER_LF_SHA256 =
  "2a8a91e0f6351afbb4304002a4fb7cd4e689602ecfbc8af418c957dcfa7da0a6";
const PARENT_RUNNER_FILTERED_OID =
  "6eca94aae046b248a278484863c2caf6001acc4d";
const PRESERVED_FUNCTIONAL_FILES = Object.freeze([
  "scripts/social-db-migrate.js",
  "src/persistence/postgres/migrations.js"
]);
const MIGRATION_FILE =
  "db/migrations/0004_social_connector_persistence.up.sql";
const CHECKSUM_FILE = "db/migrations/checksums.json";
const MIGRATION_TEST_FILE = "tests/social-postgres-migrations.test.js";
const NODE_TEST_FILE = "tests/node-test-runner-safety.test.js";
const PHYSICAL_TEST_FILE = "tests/social-3b0-linux-physical-gate.test.js";
const MIGRATION_LF_SHA256 = Object.freeze({
  [MIGRATION_FILE]:
    "91f6efc611903c40e16bd37828d5b9c1a03dfae222e1d13b5dc97f81ffde1b5d",
  [CHECKSUM_FILE]:
    "7bea25acc2a2fa899029129e75a8d66a182032264e3a3713ae4abe66e593fdc9",
  [MIGRATION_TEST_FILE]:
    "32fc1c73967c289b45908100e07c8bb64a0785a4dcdd70cd2e8dc537764fe450"
});
const MIGRATION_FILTERED_OID = Object.freeze({
  [MIGRATION_FILE]: "a564b9d4c01e5220b857a86523bb5ff8c3498b17",
  [CHECKSUM_FILE]: "1751b76e571d94cfb62898f7eb483061b549fc55",
  [MIGRATION_TEST_FILE]: "2457f6a399690117c90e702107d4981df16f5d0b"
});
const PROTECTED_FILES = Object.freeze([
  "db/migrations/0001_social_multitenant_foundation.up.sql",
  "db/migrations/0002_social_connections_and_vault.up.sql",
  "db/migrations/0003_global_vault_key_registry.up.sql",
  "db/postgres/roles.sql",
  "package.json",
  "package-lock.json"
]);
const REAL_TEST_FILE = "tests/social-postgres-real.test.js";
const REAL_TEST_LF_SHA256 =
  "e3912a2b174e7199c76035264ebe455da00848c3c61259138b9ea0b77c3e5117";
const REAL_TEST_FILTERED_OID =
  "9d841c0290b2abb102bb3ce2f7e76bc8a80fe84a";
const PARENT_REAL_TEST_LF_SHA256 =
  "d07054524efec8ac48b720eed8df7a39d2db6a8a5cda6249b80c30ec73b33a66";
const PARENT_REAL_TEST_FILTERED_OID =
  "926b6050fcb89b528126eb6fbf72f70624556a4b";
const INSTRUMENTED_LF_SHA256 = Object.freeze({
  [NODE_TEST_FILE]:
    "91e81e4d38c39eefb208bfdc0e050ea1a36f1b1f3de64f8364c91ea6f282ff17",
  [PHYSICAL_TEST_FILE]:
    "c9dc030f19a1b26bd82eea9cc2f1399568edd1efe864e84ad4aef484158bbafc",
  [REAL_TEST_FILE]: REAL_TEST_LF_SHA256
});
const INSTRUMENTED_FILTERED_OID = Object.freeze({
  [NODE_TEST_FILE]: "cd6967f8dfd6784c0e3c7b33199202b074ee1d24",
  [PHYSICAL_TEST_FILE]: "367717f49cc845d5e022fc5eaa2823cf55c0f2cc",
  [REAL_TEST_FILE]: REAL_TEST_FILTERED_OID
});
const PLAN_SUBPHASE_PARENT_REAL_TEST_LF_SHA256 =
  "27a4d1ebbccda40711fd1a78a2f170efa3128690b86588be0c7ab515345f49d0";
const PLAN_SUBPHASE_PARENT_REAL_TEST_FILTERED_OID =
  "bebdc618879cabd589dbe93a3b6a2c9a172aa98e";
const LEDGER_OID_PREDECESSOR_COMMIT =
  "05689e6d23e65c6df33e3db79633126114dea540";
const LEDGER_OID_PREDECESSOR_REAL_TEST_LF_SHA256 =
  "47d8d35369fb9a028bd3d5d2b0b9e42f1e91b914447fb7547c8421f8d2b2232b";
const LEDGER_OID_PREDECESSOR_REAL_TEST_FILTERED_OID =
  "ad9e879bd6546f9a54b3687602aa0479ad1a0027";
const PERMISSION_BOUNDARY_COMMIT =
  "555d71eacbde76ceffdd03d64731e03849978c17";
const PERMISSION_BOUNDARY_REAL_TEST_LF_SHA256 =
  "0435be028c5e3d1aa04e2094ae60f92e17528434ec63f5c31516db803fb190c7";
const PERMISSION_BOUNDARY_REAL_TEST_FILTERED_OID =
  "caa0cf840214a1ce6572c8f338a92dd4d8146e87";
const HISTORICAL_REAL_TEST_LF_SHA256 =
  "01da38a09d5a1932fcdd4507ae1ba971d46cf69ce33b8679057876578c72e6e0";
const HISTORICAL_REAL_TEST_FILTERED_OID =
  "82674f00f94537f3b1ae82567d0d11284ba2ed2e";
const REAL_TEST_BINDING_LINE = "  GLOBAL_VAULT_REGISTRY_MIGRATION,\n";
const FUNCTIONAL_FILES = Object.freeze([
  ...PRESERVED_FUNCTIONAL_FILES
]);
const FORMER_WINDOWS_WORKTREE_PINS = Object.freeze([
  "526abe4b610d9c9ae9fb8af2b263f1e37974c3e3d8bc6a51cb8c1ba90f5816fd",
  "6b67afffc8342dc514078e49785eb54665a9a709ab9673ca770b788177354374",
  "6addd77503120f85905820363e9bcd4a697f65f93038fde99f98fb63812f1227"
]);
const CLEANUP_FILES = Object.freeze([
  "tests/free_art_campaigns.test.js",
  "tests/free_art_campaigns_notifications.test.js",
  "tests/monthly_planning_photo_items.test.js",
  "tests/product_discovery.test.js"
]);
const CLEANUP_LF_SHA256 = Object.freeze({
  "tests/free_art_campaigns.test.js":
    "4703610c81876e51a378e207766d7c5e3221c746035e1f9611f2cfb78c36dae6",
  "tests/free_art_campaigns_notifications.test.js":
    "54471ed10fa99a1c056fd18180ef0793568a676bfdf5c70be5d21c120445e5a9",
  "tests/monthly_planning_photo_items.test.js":
    "8a43681bfff600d2714e94d008cecf5d369a340b3f23395d7d05ee99793e1c32",
  "tests/product_discovery.test.js":
    "dbdebb630e53466a05561ef64a8cfee9ce8bbca0ccc90dd9653a0666f60ad162"
});
const CLEANUP_FILTERED_OID = Object.freeze({
  "tests/free_art_campaigns.test.js": "004822579d89e5188e9a9c7b3c3041416e2f9060",
  "tests/free_art_campaigns_notifications.test.js": "39b76b7843c9997a74215f84bbbd0cca6af7e8c2",
  "tests/monthly_planning_photo_items.test.js": "3cf126c205f77395a470170460e7914577625845",
  "tests/product_discovery.test.js": "e2db596e3837d4ff232f647647d5076d7f0320e0"
});
const EXACT20 = Object.freeze([
  ".github/workflows/social-3b0-exact-0004-runner-linux.yml",
  "db/migrations/0004_social_connector_persistence.up.sql",
  "db/migrations/checksums.json",
  "scripts/run-node-tests.js",
  RUNNER_FILE,
  "scripts/social-3a0p-local-scope.js",
  "scripts/social-db-migrate.js",
  "src/persistence/postgres/migrations.js",
  ...CLEANUP_FILES.slice(0, -1),
  "tests/node-test-runner-safety.test.js",
  CLEANUP_FILES[CLEANUP_FILES.length - 1],
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-linux-workflow.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-exact-0004-runner-linux-workflow.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-postgres-migrations.test.js",
  "tests/social-postgres-real.test.js"
]);
const INCREMENTAL12 = Object.freeze([
  ".github/workflows/social-3b0-exact-0004-runner-linux.yml",
  "db/migrations/0004_social_connector_persistence.up.sql",
  "db/migrations/checksums.json",
  "scripts/run-real-postgres-tests.js",
  "scripts/social-3a0p-local-scope.js",
  "tests/node-test-runner-safety.test.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-exact-0004-runner-linux-workflow.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-postgres-migrations.test.js",
  "tests/social-postgres-real.test.js"
]);
const LEGACY_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "branch",
  "commit",
  "parent",
  "inventory",
  "runner",
  "nodeVersion",
  "postgresImageDigest",
  "postgresStarted",
  "testProcessStarted",
  "testFileLoaded",
  "testsDiscovered",
  "testsPassed",
  "testsFailed",
  "planExactPassed",
  "applyExactPassed",
  "concurrencyPassed",
  "rollbackPassed",
  "profileBefore",
  "profileAfter",
  "firstFailure",
  "cleanupCompleted",
  "residuals"
]);
const SAFE_EVIDENCE_KEYS = Object.freeze([
  "evidenceSchemaVersion",
  "runnerReached",
  "gateValidated",
  "nodeTestSpawnAttempted",
  "nodeTestProcessCreated",
  "nodeTestExitCode",
  "nodeTestSignal",
  "nodeTestTimedOut",
  "tapStarted",
  "tapTitleObserved",
  "firstTestDiscovered",
  "stderrCategory",
  "safeErrorCode",
  "safeModuleName",
  "firstFailureStage",
  "lastMainPhaseStarted",
  "lastMainPhaseCompleted",
  "cleanupStarted",
  "failureDuringCleanup",
  "failurePhase",
  "safePermissionOrigin",
  "safeSourceBasename",
  "safeLineBucket"
]);
const EXACT0004_EVIDENCE_KEYS = Object.freeze([
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
const EVIDENCE_KEYS = Object.freeze([
  ...LEGACY_EVIDENCE_KEYS,
  ...SAFE_EVIDENCE_KEYS,
  ...EXACT0004_EVIDENCE_KEYS
]);
const RUNNER_FACT_KEYS = Object.freeze([
  ...SAFE_EVIDENCE_KEYS.filter((key) => key !== "evidenceSchemaVersion"),
  ...EXACT0004_EVIDENCE_KEYS,
  "cleanupCompleted"
]);
const PROCESS_STATUS_KEYS = Object.freeze([
  "exitCode",
  "signal",
  "timedOut",
  "stdoutStored",
  "stderrStored"
]);
const PERMISSION_ORIGINS = Object.freeze([
  "postgres_sqlstate",
  "os_filesystem",
  "os_process",
  "unknown"
]);
const EXACT0004_SUBPHASES = Object.freeze([
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
const SAFE_OPERATION_CLASSES = Object.freeze([
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
const SAFE_ERROR_CLASSES = Object.freeze([
  "postgres_sqlstate",
  "assertion_failure",
  "environment_contract",
  "process_failure",
  "timeout",
  "unexpected_result",
  "unknown"
]);
const SAFE_SQL_STATES = Object.freeze([
  "42501",
  "23514",
  "P0001",
  "unknown",
  "not_observed"
]);
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
const CONFLICTING_NEGATIVE_DEFAULTS = Object.freeze({
  conflictingNegativeAttempted: false,
  conflictingNegativePromiseOutcome: "not_started",
  conflictingNegativeObservedSqlState: "not_observed",
  conflictingNegativeFulfilledResultClass: "not_observed",
  conflictingNegativeAssertionMatched: null,
  conflictingNegativeRejectedBeforeAssertion: null
});
const CONFLICTING_NEGATIVE_SUCCESS = Object.freeze({
  conflictingNegativeAttempted: true,
  conflictingNegativePromiseOutcome: "rejected",
  conflictingNegativeObservedSqlState: "23514",
  conflictingNegativeFulfilledResultClass: "not_observed",
  conflictingNegativeAssertionMatched: true,
  conflictingNegativeRejectedBeforeAssertion: true
});
const EXACT0004_OPERATION_BY_SUBPHASE = Object.freeze({
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

function read() {
  const stat = fs.lstatSync(FILE);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  const source = fs.readFileSync(FILE, "utf8");
  return { source, workflow: JSON.parse(source) };
}

function job(workflow) {
  assert.deepEqual(Object.keys(workflow.jobs), ["exact-0004-linux"]);
  return workflow.jobs["exact-0004-linux"];
}

function stepByName(currentJob, name) {
  const matches = currentJob.steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, name);
  return matches[0];
}

function bashExpectedInventory(source) {
  const startToken = "\nexpected=(\n";
  const endToken = "\n)\nmapfile -d '' actual";
  assert.equal(source.split(startToken).length - 1, 1);
  const start = source.indexOf(startToken) + startToken.length;
  const end = source.indexOf(endToken, start);
  assert.ok(end > start);
  return source.slice(start, end).split("\n").map((line) => {
    const match = /^  '([^']+)'$/.exec(line);
    assert.ok(match, line);
    return match[1];
  });
}

function inlineInventory(source, name) {
  const startToken = `const ${name}=[`;
  assert.equal(source.split(startToken).length - 1, 1, name);
  const start = source.indexOf(startToken) + startToken.length;
  const end = source.indexOf("]", start);
  assert.ok(end > start, name);
  return source.slice(start, end).split(",").map((entry) => {
    const match = /^'([^']+)'$/.exec(entry);
    assert.ok(match, `${name}:${entry}`);
    return match[1];
  });
}

function inlineClosedSet(source, name) {
  const startToken = `const ${name}=new Set([`;
  const endToken = "]);";
  assert.equal(source.split(startToken).length - 1, 1, name);
  const start = source.indexOf(startToken) + startToken.length;
  const end = source.indexOf(endToken, start);
  assert.ok(end > start, name);
  const values = source.slice(start, end).split(",").map((entry) => {
    const match = /^'([^']+)'$/.exec(entry);
    assert.ok(match, `${name}:${entry}`);
    return match[1];
  });
  assert.equal(new Set(values).size, values.length, `${name}:duplicate`);
  return values;
}

function inlineFunction(source, signature) {
  assert.equal(source.split(signature).length - 1, 1, signature);
  const start = source.indexOf(signature);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      assert.ok(depth >= 0, signature);
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${signature}:unterminated`);
}

function boundaryValidator(source) {
  const signature = "function validBoundary(value){";
  const physicalPhases = inlineInventory(source, "physicalPhases");
  const permissionOrigins = inlineClosedSet(source, "permissionOrigins");
  assert.deepEqual(permissionOrigins, PERMISSION_ORIGINS);
  const exact0004Subphases = inlineClosedSet(source, "exact0004Subphases");
  const safeOperationClasses = inlineClosedSet(source, "safeOperationClasses");
  const safeErrorClasses = inlineClosedSet(source, "safeErrorClasses");
  const safeSqlStates = inlineClosedSet(source, "safeSqlStates");
  const conflictingNegativePromiseOutcomes = inlineClosedSet(
    source,
    "conflictingNegativePromiseOutcomes"
  );
  const conflictingNegativeFulfilledResultClasses = inlineClosedSet(
    source,
    "conflictingNegativeFulfilledResultClasses"
  );
  assert.deepEqual(exact0004Subphases, EXACT0004_SUBPHASES);
  assert.deepEqual(safeOperationClasses, SAFE_OPERATION_CLASSES);
  assert.deepEqual(safeErrorClasses, SAFE_ERROR_CLASSES);
  assert.deepEqual(safeSqlStates, SAFE_SQL_STATES);
  assert.deepEqual(
    conflictingNegativePromiseOutcomes,
    CONFLICTING_NEGATIVE_PROMISE_OUTCOMES
  );
  assert.deepEqual(
    conflictingNegativeFulfilledResultClasses,
    CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES
  );
  const sqlStatePattern = "const postgresSqlState=/^[0-9A-Z]{5}$/;";
  assert.equal(source.split(sqlStatePattern).length - 1, 1);
  return Function(
    "mainPhases",
    "phaseSet",
    "permissionOrigins",
    "safeSources",
    "lineBuckets",
    "exact0004Route",
    "exact0004Subphases",
    "safeOperationClasses",
    "safeErrorClasses",
    "safeSqlStates",
    "postgresSqlState",
    "conflictingNegativePromiseOutcomes",
    "conflictingNegativeFulfilledResultClasses",
    "exact0004OperationBySubphase",
    [
      '"use strict";',
      inlineFunction(source, "function validConflictingNegative(value){"),
      ";",
      inlineFunction(source, "function conflictingNegativeSucceeded(value){"),
      ";",
      inlineFunction(source, signature),
      ";return validBoundary;"
    ].join("")
  )(
    physicalPhases.slice(0, -1),
    new Set(physicalPhases),
    new Set(permissionOrigins),
    new Set(inlineClosedSet(source, "safeSources")),
    new Set(inlineClosedSet(source, "lineBuckets")),
    EXACT0004_SUBPHASES.slice(0, -2),
    new Set(exact0004Subphases),
    new Set(safeOperationClasses),
    new Set(safeErrorClasses),
    new Set(safeSqlStates),
    /^[0-9A-Z]{5}$/,
    new Set(conflictingNegativePromiseOutcomes),
    new Set(conflictingNegativeFulfilledResultClasses),
    EXACT0004_OPERATION_BY_SUBPHASE
  );
}

function functionalPins(source) {
  const startToken = "declare -A functional=(\n";
  const endToken = "\n)\nfor file in \"${!functional[@]}\";";
  assert.equal(source.split(startToken).length - 1, 1);
  const start = source.indexOf(startToken) + startToken.length;
  const end = source.indexOf(endToken, start);
  assert.ok(end > start);
  return Object.fromEntries(source.slice(start, end).split("\n").map((line) => {
    const match = /^  \['([^']+)'\]='([0-9a-f]{64})'$/.exec(line);
    assert.ok(match, line);
    return [match[1], match[2]];
  }));
}

function associativePinMaps(source) {
  const expression =
    /declare -A ([A-Za-z_][A-Za-z0-9_]*)=\(\n([\s\S]*?)\n\)\nfor file in "\$\{!\1\[@\]\}";/g;
  return [...source.matchAll(expression)].map((match) => {
    const entries = match[2].split("\n").map((line) => {
      const entry = /^  \['([^']+)'\]='([0-9a-f]{64})'$/.exec(line);
      assert.ok(entry, `${match[1]}:${line}`);
      return [entry[1], entry[2]];
    });
    assert.equal(new Set(entries.map(([file]) => file)).size, entries.length);
    return Object.freeze({
      name: match[1],
      pins: Object.freeze(Object.fromEntries(entries))
    });
  });
}

function namedPinMap(source, name) {
  const matches = associativePinMaps(source).filter((entry) =>
    entry.name === name
  );
  assert.equal(matches.length, 1, `${name} pin map`);
  return matches[0];
}

function runnerPinMap(source) {
  const matches = associativePinMaps(source).filter(({ pins }) =>
    Object.prototype.hasOwnProperty.call(pins, RUNNER_FILE)
  );
  assert.equal(matches.length, 1, "runner pin map");
  return matches[0];
}

function physicalTestPinMap(source) {
  const matches = associativePinMaps(source).filter(({ pins }) =>
    Object.prototype.hasOwnProperty.call(pins, REAL_TEST_FILE)
  );
  assert.equal(matches.length, 1, "physical test pin map");
  return matches[0];
}

function bashIncrementalInventory(source) {
  const startToken = "incremental_expected=(\n";
  const endToken = "\n)\nmapfile -d '' incremental_actual";
  assert.equal(source.split(startToken).length - 1, 1);
  const start = source.indexOf(startToken) + startToken.length;
  const end = source.indexOf(endToken, start);
  assert.ok(end > start);
  return source.slice(start, end).split("\n").map((line) => {
    const match = /^  '([^']+)'$/.exec(line);
    assert.ok(match, line);
    return match[1];
  });
}

function bashProtectedInventory(source) {
  const startToken = "protected=(\n";
  const endToken = "\n)\nfor file in \"${protected[@]}\";";
  assert.equal(source.split(startToken).length - 1, 1);
  const start = source.indexOf(startToken) + startToken.length;
  const end = source.indexOf(endToken, start);
  assert.ok(end > start);
  return source.slice(start, end).split("\n").map((line) => {
    const match = /^  '([^']+)'$/.exec(line);
    assert.ok(match, line);
    return match[1];
  });
}

function cleanupPinMap(source) {
  const matches = associativePinMaps(source).filter(({ pins }) => (
    Object.keys(pins).length === CLEANUP_FILES.length &&
    CLEANUP_FILES.every((file) => Object.prototype.hasOwnProperty.call(pins, file))
  ));
  assert.equal(matches.length, 1, "cleanup pin map");
  return matches[0];
}

function inlineArrayContaining(source, requiredEntry) {
  const arrays = [...source.matchAll(
    /const ([A-Za-z_$][A-Za-z0-9_$]*)=\[([^\]]*)\]/g
  )].filter((match) => match[2].includes(`'${requiredEntry}'`)).map((match) => {
    const values = match[2] === "" ? [] : match[2].split(",").map((entry) => {
      const value = /^'([^']+)'$/.exec(entry);
      assert.ok(value, `${match[1]}:${entry}`);
      return value[1];
    });
    return Object.freeze({ name: match[1], values: Object.freeze(values) });
  }).filter(({ values }) => values.includes(requiredEntry));
  assert.equal(arrays.length, 1, requiredEntry);
  assert.equal(new Set(arrays[0].values).size, arrays[0].values.length);
  return arrays[0];
}

function assertExactKeysCall(source, valueName, arrayName) {
  const expression = new RegExp(
    `exactKeys\\(\\s*${valueName}\\s*,\\s*${arrayName}\\s*\\)`
  );
  assert.match(source, expression);
}

function physicalRunnerImports(source) {
  return [...source.matchAll(
    /const\s*\{([^}]*)\}\s*=\s*require\((['"])([^'"]+)\2\)/g
  )].map((match) => Object.freeze({
    bindings: Object.freeze(match[1].split(",").map((name) => name.trim())),
    target: match[3]
  })).filter(({ target }) => target.includes("run-real-postgres-tests"));
}

function canonicalLfBytes(relative) {
  const raw = fs.readFileSync(path.join(ROOT, ...relative.split("/")));
  assert.equal(
    raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
    false,
    `${relative}:bom`
  );
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const normalized = decoded.replaceAll("\r\n", "\n");
  assert.equal(normalized.includes("\r"), false, `${relative}:bare-cr`);
  return Buffer.from(normalized, "utf8");
}

function gitBlobOid(bytes) {
  return crypto.createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function git(args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0"
    }
  });
}

test("Exact-0004 Linux workflow is strict JSON with the one authorized trigger", () => {
  const { source, workflow } = read();
  assert.deepEqual(workflow.on, { push: { branches: [BRANCH] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "social-3b0-exact-0004-runner-linux",
    "cancel-in-progress": false
  });
  assert.equal(source.includes("workflow_dispatch"), false);
  assert.equal(source.includes("pull_request"), false);
  assert.equal(source.includes("schedule"), false);
  assert.equal(source.includes("workflow_call"), false);
  assert.equal(source.includes("${{ secrets."), false);
  assert.equal(source.includes("environment:"), false);
  assert.equal(source.includes("permissions: write"), false);
});

test("Exact-0004 Linux workflow fixes branch, immediate parent, ancestral base, message and Exact20", () => {
  const { source, workflow } = read();
  assert.deepEqual(workflow.env, {
    SOCIAL_EXACT_BASE: BASE,
    SOCIAL_EXACT_PARENT: PARENT,
    SOCIAL_EXACT_BRANCH: BRANCH,
    SOCIAL_EXACT_MESSAGE: MESSAGE,
    SOCIAL_EXACT_POSTGRES_IMAGE: IMAGE
  });
  const currentJob = job(workflow);
  for (const fragment of [
    "github.event_name == 'push'",
    `github.ref == 'refs/heads/${BRANCH}'`,
    "github.event.created == true",
    "github.event.deleted == false",
    "github.event.forced == false",
    "github.event.before == '0000000000000000000000000000000000000000'",
    `github.event.head_commit.message == '${MESSAGE}'`,
    "github.run_attempt == 1"
  ]) assert.ok(currentJob.if.includes(fragment), fragment);
  const guard = stepByName(currentJob, "Verify immutable Exact20 contract").run;
  assert.ok(
    guard.includes(
      '[[ "$(git rev-parse HEAD^)" == "${SOCIAL_EXACT_PARENT}" ]] || fail'
    )
  );
  assert.ok(guard.includes("git rev-list --parents -n 1 HEAD"));
  assert.ok(guard.includes('${parents[1]}" == "${SOCIAL_EXACT_PARENT}'));
  assert.ok(guard.includes(
    "mapfile -d '' incremental_actual < <(git diff-tree --no-commit-id --name-only -r --no-renames -z \"${SOCIAL_EXACT_PARENT}\" HEAD --)"
  ));
  assert.ok(guard.includes(
    '[[ "${#incremental_actual[@]}" == "${#incremental_expected[@]}" ]] || fail'
  ));
  assert.ok(guard.includes(
    '[[ "$(printf \'%s\\n\' "${incremental_actual_sorted[@]}")" == "$(printf \'%s\\n\' "${incremental_expected_sorted[@]}")" ]] || fail'
  ));
  assert.ok(guard.includes(
    "mapfile -d '' actual < <(git diff-tree --no-commit-id --name-only -r --no-renames -z \"${SOCIAL_EXACT_BASE}\" HEAD --)"
  ));
  assert.ok(guard.includes(
    '[[ "${#actual[@]}" == "${#expected[@]}" ]] || fail'
  ));
  assert.ok(guard.includes(
    '[[ "$(printf \'%s\\n\' "${actual_sorted[@]}")" == "$(printf \'%s\\n\' "${expected_sorted[@]}")" ]] || fail'
  ));
  assert.equal(EXACT20.length, 20);
  assert.equal(new Set(EXACT20).size, 20);
  const guardInventory = bashExpectedInventory(guard);
  assert.deepEqual(guardInventory, EXACT20);
  assert.equal(INCREMENTAL12.length, 12);
  assert.equal(new Set(INCREMENTAL12).size, 12);
  assert.deepEqual(bashIncrementalInventory(guard), INCREMENTAL12);
  assert.deepEqual(bashProtectedInventory(guard), PROTECTED_FILES);
  const physical = stepByName(
    currentJob,
    "Run the one-shot PostgreSQL 18 Exact-0004 proof"
  );
  const finalize = stepByName(currentJob, "Finalize sanitized four-file evidence");
  const enforcement = stepByName(currentJob, "Enforce final Exact-0004 result");
  assert.ok(
    physical.run.includes(
      "safeRouteEnv=new Set(['SOCIAL_EXACT_BASE','SOCIAL_EXACT_PARENT'"
    )
  );
  assert.equal(
    physical.run.split("parent:process.env.SOCIAL_EXACT_PARENT").length - 1,
    1
  );
  assert.equal(
    finalize.run.split("parent:process.env.SOCIAL_EXACT_PARENT").length - 1,
    1
  );
  assert.ok(
    finalize.run.includes("value.parent!==process.env.SOCIAL_EXACT_PARENT")
  );
  assert.ok(
    enforcement.run.includes(
      "evidence.parent!==process.env.SOCIAL_EXACT_PARENT"
    )
  );
  assert.equal(source.includes("parent:process.env.SOCIAL_EXACT_BASE"), false);
  assert.ok(guard.includes('${SOCIAL_EXACT_PARENT}:$file'));
  assert.ok(guard.includes('${SOCIAL_EXACT_BASE}:$file'));
  const physicalInventory = inlineInventory(physical.run, "inventory");
  const finalizeInventory = inlineInventory(finalize.run, "inventory");
  const enforcementInventory = inlineInventory(
    enforcement.run,
    "expectedInventory"
  );
  for (const [name, inventory] of [
    ["guard", guardInventory],
    ["physical", physicalInventory],
    ["finalizer", finalizeInventory],
    ["enforcement", enforcementInventory]
  ]) {
    assert.deepEqual(inventory, EXACT20, name);
    assert.equal(
      inventory.filter((file) => file === RUNNER_FILE).length,
      1,
      name
    );
  }
  const { pins: runnerPins } = runnerPinMap(guard);
  assert.deepEqual(runnerPins, { [RUNNER_FILE]: RUNNER_LF_SHA256 });
  assert.deepEqual(namedPinMap(guard, "migration").pins, MIGRATION_LF_SHA256);
  const { name: physicalPinMapName, pins: physicalPins } =
    physicalTestPinMap(guard);
  assert.equal(physicalPinMapName, "instrumented");
  assert.deepEqual(physicalPins, INSTRUMENTED_LF_SHA256);
  const { pins: cleanupPins } = cleanupPinMap(guard);
  assert.deepEqual(cleanupPins, CLEANUP_LF_SHA256);
  assert.equal(
    source.split(`'${RUNNER_FILE}'`).length - 1,
    6,
    "six semantic runner path positions"
  );
  const imports = physicalRunnerImports(physical.run);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].target, RUNNER_MODULE);
  assert.deepEqual(
    [...imports[0].bindings].sort(),
    ["EVIDENCE_SCHEMA_VERSION", "createSafeEventCollector"].sort()
  );
  assert.equal(
    physical.run.includes(`require('${RUNNER_MODULE}.js')`),
    false
  );
  assert.equal(source.includes("Exact12"), false);
  assert.equal(source.includes("exact12_contract_failed"), false);
  assert.equal(source.includes("Exact13"), false);
  assert.equal(source.includes("exact13_contract_failed"), false);
  assert.equal(
    source.includes(
      "social/checkpoint-3b0-exact-0004-runner-linux-lf-pins-20260814"
    ),
    false
  );
  assert.equal(
    source.includes(
      "[run-social-3b0] validate exact 0004 runner with canonical LF pins"
    ),
    false
  );
  assert.equal(
    source.includes(
      "c9449d52b10638ab5c4da53fdea0a126f2d08180f7f1760c64226e4df852e9cb"
    ),
    false
  );
  for (const stale of [
    "social/checkpoint-3b0-exact-0004-runner-linux-conflict-sqlstate-20260820",
    "[run-social-3b0] align exact 0004 conflict SQLSTATE",
    "53bae8b3457b515b0e656d5b37fce4dc04d5e89f",
    "social/checkpoint-3b0-exact-0004-runner-linux-ledger-oid-boundary-20260816",
    "[run-social-3b0] resolve exact 0004 ledger privilege by oid",
    "social/checkpoint-3b0-exact-0004-runner-linux-snapshot-role-binding-20260815",
    "[run-social-3b0] bind exact 0004 snapshots to migrator role",
    "social/checkpoint-3b0-exact-0004-runner-linux-permission-boundary-20260814",
    "[run-social-3b0] pinpoint exact 0004 permission boundary",
    PERMISSION_BOUNDARY_COMMIT,
    PERMISSION_BOUNDARY_REAL_TEST_LF_SHA256,
    "social/checkpoint-3b0-exact-0004-runner-linux-safe-evidence-20260814",
    "[run-social-3b0] preserve safe evidence before exact 0004 TAP",
    "eb92d862c70a78a907e82628cd6a5768ecc8f113570dd13ba5d3ca8cc15f8f98",
    HISTORICAL_REAL_TEST_LF_SHA256
  ]) assert.equal(source.includes(stale), false, stale);
  assert.equal((guard.match(/migration=\(/g) || []).length, 1);
  assert.equal((guard.match(/functional=\(/g) || []).length, 1);
  assert.equal((guard.match(/instrumented=\(/g) || []).length, 1);
  assert.ok(guard.includes("100644") && guard.includes("blob"));
});

test("functional and instrumented pins come from canonical Git blobs", () => {
  const { workflow } = read();
  const guard = stepByName(
    job(workflow),
    "Verify immutable Exact20 contract"
  ).run;
  const pins = functionalPins(guard);
  const { name: physicalPinMapName, pins: physicalPins } =
    physicalTestPinMap(guard);
  assert.equal(physicalPinMapName, "instrumented");
  assert.deepEqual(Object.keys(pins), FUNCTIONAL_FILES);
  assert.deepEqual(physicalPins, INSTRUMENTED_LF_SHA256);
  let materializationDiffers = false;
  for (const file of PRESERVED_FUNCTIONAL_FILES) {
    const stat = fs.lstatSync(path.join(ROOT, ...file.split("/")));
    assert.equal(stat.isFile(), true, file);
    assert.equal(stat.isSymbolicLink(), false, file);
    const entry = git(["ls-tree", SOURCE_COMMIT, "--", file]).trim();
    const match = /^(100644) (blob) ([0-9a-f]{40})\t(.+)$/.exec(entry);
    assert.ok(match, file);
    assert.equal(match[4], file);
    const sourceOid = match[3];
    const candidateOid = git([
      "hash-object",
      `--path=${file}`,
      "--",
      file
    ]).trim();
    assert.equal(candidateOid, sourceOid, file);
    const canonicalBytes = git([
      "cat-file",
      "blob",
      `${SOURCE_COMMIT}:${file}`
    ], null);
    assert.ok(Buffer.isBuffer(canonicalBytes), file);
    assert.equal(
      crypto.createHash("sha256").update(canonicalBytes).digest("hex"),
      pins[file],
      file
    );
    const rawWorktreeOid = git([
      "hash-object",
      "--no-filters",
      "--",
      file
    ]).trim();
    if (rawWorktreeOid !== candidateOid) materializationDiffers = true;
  }
  const historicalEntry = git([
    "ls-tree",
    SOURCE_COMMIT,
    "--",
    REAL_TEST_FILE
  ]).trim();
  const historicalMatch = /^(100644) (blob) ([0-9a-f]{40})\t(.+)$/.exec(
    historicalEntry
  );
  assert.ok(historicalMatch);
  assert.equal(historicalMatch[3], HISTORICAL_REAL_TEST_FILTERED_OID);
  assert.equal(historicalMatch[4], REAL_TEST_FILE);
  const historicalBytes = git([
    "cat-file",
    "blob",
    `${SOURCE_COMMIT}:${REAL_TEST_FILE}`
  ], null);
  assert.ok(Buffer.isBuffer(historicalBytes));
  assert.equal(
    crypto.createHash("sha256").update(historicalBytes).digest("hex"),
    HISTORICAL_REAL_TEST_LF_SHA256
  );
  const currentBytes = canonicalLfBytes(REAL_TEST_FILE);
  assert.equal(
    crypto.createHash("sha256").update(currentBytes).digest("hex"),
    REAL_TEST_LF_SHA256
  );
  assert.equal(physicalPins[REAL_TEST_FILE], REAL_TEST_LF_SHA256);
  assert.equal(gitBlobOid(currentBytes), REAL_TEST_FILTERED_OID);
  assert.equal(
    git([
      "hash-object",
      `--path=${REAL_TEST_FILE}`,
      "--",
      REAL_TEST_FILE
    ]).trim(),
    REAL_TEST_FILTERED_OID
  );
  const currentSource = currentBytes.toString("utf8");
  assert.equal(currentSource.split(REAL_TEST_BINDING_LINE).length - 1, 1);
  assert.equal(
    (currentSource.match(/\bGLOBAL_VAULT_REGISTRY_MIGRATION\b/g) || []).length,
    4
  );
  assert.equal(currentSource.includes("0003_global_vault_key_registry"), false);
  const migrationsSource = canonicalLfBytes(
    "src/persistence/postgres/migrations.js"
  ).toString("utf8");
  const exportBlock = /module\.exports\s*=\s*\{([^{}]*)\};/.exec(
    migrationsSource
  );
  assert.ok(exportBlock);
  assert.equal(
    (exportBlock[1].match(/\bGLOBAL_VAULT_REGISTRY_MIGRATION\b/g) || []).length,
    1
  );
  const rawRealTestOid = git([
    "hash-object",
    "--no-filters",
    "--",
    REAL_TEST_FILE
  ]).trim();
  if (rawRealTestOid !== REAL_TEST_FILTERED_OID) materializationDiffers = true;
  for (const file of [NODE_TEST_FILE, PHYSICAL_TEST_FILE]) {
    const canonical = canonicalLfBytes(file);
    assert.equal(
      crypto.createHash("sha256").update(canonical).digest("hex"),
      INSTRUMENTED_LF_SHA256[file],
      file
    );
    assert.equal(gitBlobOid(canonical), INSTRUMENTED_FILTERED_OID[file], file);
    assert.equal(
      git(["hash-object", `--path=${file}`, "--", file]).trim(),
      INSTRUMENTED_FILTERED_OID[file],
      file
    );
  }
  if (process.platform === "win32") assert.equal(materializationDiffers, true);
  for (const formerPin of FORMER_WINDOWS_WORKTREE_PINS) {
    assert.equal(Object.values(pins).includes(formerPin), false, formerPin);
    assert.equal(Object.values(physicalPins).includes(formerPin), false, formerPin);
  }
});

test("0004 conflict gates are physical, checksum-bound and reconstruct only the authorized parent delta", () => {
  const { workflow } = read();
  const guard = stepByName(
    job(workflow),
    "Verify immutable Exact20 contract"
  ).run;
  assert.deepEqual(namedPinMap(guard, "migration").pins, MIGRATION_LF_SHA256);

  for (const file of Object.keys(MIGRATION_LF_SHA256)) {
    const canonical = canonicalLfBytes(file);
    assert.equal(
      crypto.createHash("sha256").update(canonical).digest("hex"),
      MIGRATION_LF_SHA256[file],
      file
    );
    assert.equal(gitBlobOid(canonical), MIGRATION_FILTERED_OID[file], file);
    assert.equal(
      git(["hash-object", `--path=${file}`, "--", file]).trim(),
      MIGRATION_FILTERED_OID[file],
      file
    );
  }

  const migrationSource = canonicalLfBytes(MIGRATION_FILE).toString("utf8");
  const parentMigrationSource = git([
    "cat-file",
    "blob",
    `${PARENT}:${MIGRATION_FILE}`
  ], null).toString("utf8");
  const currentStart = migrationSource.indexOf(
    "DO $social_connector_blocking_connection_gate$"
  );
  const parentStart = parentMigrationSource.indexOf(
    "DO $social_connector_preflight$"
  );
  const nextStatement =
    "ALTER TABLE ia4tube_social.social_external_accounts";
  const currentEnd = migrationSource.indexOf(nextStatement, currentStart);
  const parentEnd = parentMigrationSource.indexOf(nextStatement, parentStart);
  assert.ok(currentStart >= 0 && currentEnd > currentStart);
  assert.ok(parentStart >= 0 && parentEnd > parentStart);
  const currentGateBlock = migrationSource.slice(currentStart, currentEnd);
  const parentGateBlock = parentMigrationSource.slice(parentStart, parentEnd);
  assert.equal(
    migrationSource.replace(currentGateBlock, parentGateBlock),
    parentMigrationSource
  );

  const gates = [
    {
      delimiter: "social_connector_blocking_connection_gate",
      index: "social_connections_instagram_blocking_company_unique",
      message: "social_connector_blocking_connection_conflict"
    },
    {
      delimiter: "social_connector_active_account_gate",
      index: "social_external_accounts_instagram_active_company_unique",
      message: "social_connector_active_account_conflict"
    }
  ];
  for (const gate of gates) {
    const expression = new RegExp(
      `DO \\$${gate.delimiter}\\$([\\s\\S]*?)` +
      `\\$${gate.delimiter}\\$;`,
      "g"
    );
    const matches = [...migrationSource.matchAll(expression)];
    assert.equal(matches.length, 1, gate.delimiter);
    const body = matches[0][1];
    assert.equal(
      body.split(`CREATE UNIQUE INDEX ${gate.index}`).length - 1,
      1,
      gate.index
    );
    assert.deepEqual(
      [...body.matchAll(/\bWHEN\s+([a-z_][a-z0-9_]*)\s+THEN\b/g)]
        .map((match) => match[1]),
      ["unique_violation"]
    );
    assert.deepEqual(
      [...body.matchAll(/\bERRCODE\s*=\s*'([^']+)'/g)]
        .map((match) => match[1]),
      ["23514"]
    );
    assert.deepEqual(
      [...body.matchAll(/\bMESSAGE\s*=\s*'([^']+)'/g)]
        .map((match) => match[1]),
      [gate.message]
    );
    assert.equal(/\bWHEN\s+OTHERS\b/i.test(body), false);
    assert.equal(/\bSELECT\b/i.test(body), false);
    assert.equal(/\bCONCURRENTLY\b/i.test(body), false);
  }
  assert.equal(/DO \$social_connector_preflight\$/i.test(migrationSource), false);
  assert.equal(
    /SELECT\s+1\s+FROM\s+ia4tube_social\.(?:social_connections|social_external_accounts)/i
      .test(migrationSource),
    false
  );
  assert.equal(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(
    migrationSource
  ), false);
  assert.equal(/(?:^|\n)\s*(?:COMMIT|ROLLBACK)\s*;/i.test(migrationSource), false);

  const checksumSource = canonicalLfBytes(CHECKSUM_FILE).toString("utf8");
  const parentChecksumSource = git([
    "cat-file",
    "blob",
    `${PARENT}:${CHECKSUM_FILE}`
  ], null).toString("utf8");
  const currentChecksums = JSON.parse(checksumSource).migrations;
  const parentChecksums = JSON.parse(parentChecksumSource).migrations;
  assert.deepEqual(currentChecksums.slice(0, 3), parentChecksums.slice(0, 3));
  assert.equal(currentChecksums[3].version, "0004_social_connector_persistence");
  assert.equal(currentChecksums[3].sha256, MIGRATION_LF_SHA256[MIGRATION_FILE]);
  assert.equal(
    checksumSource.replace(
      MIGRATION_LF_SHA256[MIGRATION_FILE],
      parentChecksums[3].sha256
    ),
    parentChecksumSource
  );

  assert.deepEqual(bashProtectedInventory(guard), PROTECTED_FILES);
  for (const file of PROTECTED_FILES) {
    const parentOid = git(["rev-parse", `${PARENT}:${file}`]).trim();
    const baseOid = git(["rev-parse", `${BASE}:${file}`]).trim();
    assert.equal(parentOid, baseOid, file);
  }
});

test("cleanup-only baseline proof preserves runtime TEMP cardinality", () => {
  for (const file of CLEANUP_FILES) {
    const baseline = git(["show", `${BASE}:${file}`]);
    const current = canonicalLfBytes(file).toString("utf8");
    const baselineCreations = baseline.match(/\bfs\.mkdtempSync\(/g) || [];
    const currentCreations = current.match(/\bfs\.mkdtempSync\(/g) || [];

    if (file === "tests/product_discovery.test.js") {
      const exactCount = (source, token) => source.split(token).length - 1;
      const baselineInstitutional = inlineFunction(
        baseline,
        "async function testInstitutionalOnlyResponseReturnsNoItems() {"
      );
      const baselineOneImage = inlineFunction(
        baseline,
        "async function testOneImageStructuredRequest() {"
      );
      const baselineRun = inlineFunction(baseline, "async function run() {");
      const helper = inlineFunction(current, "function tempRoot(prefix) {");
      const currentInstitutional = inlineFunction(
        current,
        "async function testInstitutionalOnlyResponseReturnsNoItems() {"
      );
      const currentOneImage = inlineFunction(
        current,
        "async function testOneImageStructuredRequest() {"
      );
      const currentRegistration = inlineFunction(
        current,
        "function registerTempDirectory(directory) {"
      );
      const currentCleanup = inlineFunction(
        current,
        "function finishTempCleanup(hasPrimaryFailure) {"
      );
      const currentRun = inlineFunction(current, "async function run() {");

      assert.equal(baselineCreations.length, 2, file);
      assert.equal(
        exactCount(baselineInstitutional, "fs.mkdtempSync("),
        1,
        file
      );
      assert.equal(exactCount(baselineOneImage, "fs.mkdtempSync("), 1, file);
      assert.equal(
        exactCount(
          baselineRun,
          "await testInstitutionalOnlyResponseReturnsNoItems();"
        ),
        1,
        file
      );
      assert.equal(
        exactCount(baselineRun, "await testOneImageStructuredRequest();"),
        1,
        file
      );

      assert.equal(
        helper,
        [
          "function tempRoot(prefix) {",
          "  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));",
          "  return registerTempDirectory(directory);",
          "}"
        ].join("\n"),
        file
      );
      assert.equal(
        exactCount(
          currentInstitutional,
          'tempRoot("ia4tube-discovery-institutional-")'
        ),
        1,
        file
      );
      assert.equal(
        exactCount(currentOneImage, 'tempRoot("ia4tube-discovery-")'),
        1,
        file
      );

      const primitiveDefinitions = exactCount(helper, "fs.mkdtempSync(");
      const helperInvocations =
        exactCount(currentInstitutional, "tempRoot(") +
        exactCount(currentOneImage, "tempRoot(");
      const runtimeTempRootsCreated =
        primitiveDefinitions * helperInvocations;
      const registeredRoots =
        exactCount(helper, "return registerTempDirectory(directory);") *
        helperInvocations;
      const baselineCleanupCoveredRoots = exactCount(
        baselineInstitutional,
        "fs.rmSync(dir, { recursive: true, force: true });"
      );
      const historicalResidualRootsAttributed =
        baselineCreations.length - baselineCleanupCoveredRoots;
      const directMkdtempCallsOutsideHelper =
        currentCreations.length - primitiveDefinitions;

      assert.equal(exactCount(current, "tempRoot("), helperInvocations + 1, file);
      assert.equal(exactCount(baseline, "fs.rmSync("), 1, file);
      assert.equal(exactCount(baselineOneImage, "fs.rmSync("), 0, file);
      assert.equal(
        exactCount(
          currentRegistration,
          "trackedTempDirectories.push(record);"
        ),
        1,
        file
      );
      assert.equal(
        currentRegistration.indexOf("trackedTempDirectories.push(record);") <
          currentRegistration.indexOf("try {"),
        true,
        file
      );
      assert.equal(
        exactCount(
          currentCleanup,
          "while (trackedTempDirectories.length > 0) {"
        ),
        1,
        file
      );
      assert.equal(
        exactCount(
          currentCleanup,
          "const record = trackedTempDirectories.pop();"
        ),
        1,
        file
      );
      assert.equal(
        exactCount(currentCleanup, "removeTrackedTempDirectory(record);"),
        1,
        file
      );
      assert.equal(exactCount(currentRun, "try {"), 1, file);
      assert.equal(exactCount(currentRun, "} catch (error) {"), 1, file);
      assert.equal(exactCount(currentRun, "} finally {"), 1, file);
      assert.equal(
        exactCount(currentRun, "finishTempCleanup(hasPrimaryFailure);"),
        1,
        file
      );
      assert.equal(
        exactCount(
          currentRun,
          "await testInstitutionalOnlyResponseReturnsNoItems();"
        ),
        1,
        file
      );
      assert.equal(
        exactCount(currentRun, "await testOneImageStructuredRequest();"),
        1,
        file
      );
      assert.equal(
        exactCount(currentInstitutional, "assert.deepStrictEqual("),
        1,
        file
      );
      assert.equal(exactCount(currentOneImage, "assert.strictEqual("), 5, file);

      const cleanupCoveredRoots = registeredRoots;
      assert.deepEqual(
        {
          primitiveDefinitions,
          helperInvocations,
          runtimeTempRootsCreated,
          cleanupCoveredRoots,
          historicalResidualRootsAttributed,
          directMkdtempCallsOutsideHelper
        },
        {
          primitiveDefinitions: 1,
          helperInvocations: 2,
          runtimeTempRootsCreated: 2,
          cleanupCoveredRoots: 2,
          historicalResidualRootsAttributed: 1,
          directMkdtempCallsOutsideHelper: 0
        },
        file
      );
    } else {
      assert.equal(currentCreations.length, baselineCreations.length, file);
    }

    assert.ok(current.includes("registerTempDirectory"), file);
    assert.ok(current.includes("finishTempCleanup"), file);
    assert.equal(current.includes("fs.rmSync(os.tmpdir()"), false, file);
    assert.equal(current.includes("fs.rmSync(path.dirname("), false, file);
  }
});

test("cleanup pins come from canonical Git LF blobs", () => {
  const { workflow } = read();
  const guard = stepByName(
    job(workflow),
    "Verify immutable Exact20 contract"
  ).run;
  const { name, pins } = cleanupPinMap(guard);
  assert.equal(name, "cleanup");
  assert.deepEqual(pins, CLEANUP_LF_SHA256);
  assert.deepEqual(Object.keys(CLEANUP_FILTERED_OID), CLEANUP_FILES);
  for (const file of CLEANUP_FILES) {
    const canonical = canonicalLfBytes(file);
    assert.equal(
      crypto.createHash("sha256").update(canonical).digest("hex"),
      CLEANUP_LF_SHA256[file],
      file
    );
    assert.equal(gitBlobOid(canonical), CLEANUP_FILTERED_OID[file], file);
    assert.equal(
      git(["hash-object", `--path=${file}`, "--", file]).trim(),
      CLEANUP_FILTERED_OID[file],
      file
    );
  }
});

test("ledger OID parent remains exact atop snapshot-role binding and preserves its historical proof", () => {
  const parentBytes = git([
    "cat-file",
    "blob",
    `${PLAN_SUBPHASE_PARENT}:${REAL_TEST_FILE}`
  ], null);
  assert.ok(Buffer.isBuffer(parentBytes));
  assert.equal(
    crypto.createHash("sha256").update(parentBytes).digest("hex"),
    PLAN_SUBPHASE_PARENT_REAL_TEST_LF_SHA256
  );
  assert.equal(
    gitBlobOid(parentBytes),
    PLAN_SUBPHASE_PARENT_REAL_TEST_FILTERED_OID
  );
  const parentSource = parentBytes.toString("utf8");
  const ledgerPredecessorBytes = git([
    "cat-file",
    "blob",
    `${LEDGER_OID_PREDECESSOR_COMMIT}:${REAL_TEST_FILE}`
  ], null);
  assert.ok(Buffer.isBuffer(ledgerPredecessorBytes));
  assert.equal(
    crypto.createHash("sha256").update(ledgerPredecessorBytes).digest("hex"),
    LEDGER_OID_PREDECESSOR_REAL_TEST_LF_SHA256
  );
  assert.equal(
    gitBlobOid(ledgerPredecessorBytes),
    LEDGER_OID_PREDECESSOR_REAL_TEST_FILTERED_OID
  );
  const ledgerPredecessorSource = ledgerPredecessorBytes.toString("utf8");
  const latestSource = parentSource;
  const helperSignature =
    "async function proveMigratorExplicitRoleBoundary(pool) {";
  const parentHelper = inlineFunction(ledgerPredecessorSource, helperSignature);
  const latestHelper = inlineFunction(latestSource, helperSignature);
  const physicalReadMarker = "  const ledgerRead =";
  const parentMarker = parentHelper.indexOf(physicalReadMarker);
  const latestMarker = latestHelper.indexOf(physicalReadMarker);
  assert.ok(parentMarker > 0);
  assert.ok(latestMarker > 0);
  assert.equal(latestHelper.slice(latestMarker), parentHelper.slice(parentMarker));
  const rewriteExactlyOnce = (source, before, after, label) => {
    assert.equal(source.split(before).length - 1, 1, label);
    return source.replace(before, after);
  };
  let expectedLatestHelper = parentHelper;
  expectedLatestHelper = rewriteExactlyOnce(
    expectedLatestHelper,
    [
      '      "  NOT has_schema_privilege(",',
      '      "    session_user, \'ia4tube_migrations\', \'USAGE\'",',
      '      "  ) AS direct_schema_usage_absent,",',
      '      "  NOT has_table_privilege(",',
      '      "    session_user, \'ia4tube_migrations.schema_migrations\', \'SELECT\'",'
    ].join("\n"),
    [
      '      "  member.oid AS member_oid,",',
      '      "  namespace.oid AS namespace_oid,",',
      '      "  relation.oid AS relation_oid,",',
      '      "  relation.relkind AS relation_kind,",',
      '      "  NOT pg_catalog.has_schema_privilege(",',
      '      "    member.oid, namespace.oid, \'USAGE\'",',
      '      "  ) AS direct_schema_usage_absent,",',
      '      "  NOT pg_catalog.has_table_privilege(",',
      '      "    member.oid, relation.oid, \'SELECT\'",'
    ].join("\n"),
    "OID privilege operands"
  );
  expectedLatestHelper = rewriteExactlyOnce(
    expectedLatestHelper,
    [
      '      "JOIN pg_catalog.pg_roles member",',
      '      "  ON member.oid = membership.member",'
    ].join("\n"),
    [
      '      "JOIN pg_catalog.pg_roles member",',
      '      "  ON member.oid = membership.member",',
      '      "JOIN pg_catalog.pg_namespace namespace",',
      '      "  ON namespace.nspname = \'ia4tube_migrations\'",',
      '      "JOIN pg_catalog.pg_class relation",',
      '      "  ON relation.relnamespace = namespace.oid",',
      '      "  AND relation.relname = \'schema_migrations\'",',
      '      "  AND relation.relkind = \'r\'",'
    ].join("\n"),
    "catalog OID joins"
  );
  expectedLatestHelper = rewriteExactlyOnce(
    expectedLatestHelper,
    [
      '      "WHERE granted.rolname = $1",',
      '      "  AND member.rolname = session_user"'
    ].join("\n"),
    [
      '      "WHERE granted.rolname = $1",',
      '      "  AND member.rolname = session_user",',
      '      "  AND member.oid IS NOT NULL",',
      '      "  AND namespace.oid IS NOT NULL",',
      '      "  AND relation.oid IS NOT NULL"'
    ].join("\n"),
    "catalog OID guards"
  );
  expectedLatestHelper = rewriteExactlyOnce(
    expectedLatestHelper,
    [
      "  assert.equal(boundary.rowCount, 1);",
      "  assert.deepEqual(boundary.rows[0], {"
    ].join("\n"),
    [
      "  assert.equal(boundary.rowCount, 1);",
      "  const {",
      "    member_oid: memberOid,",
      "    namespace_oid: namespaceOid,",
      "    relation_oid: relationOid,",
      "    relation_kind: relationKind,",
      "    ...boundaryFacts",
      "  } = boundary.rows[0];",
      "  for (const oid of [memberOid, namespaceOid, relationOid]) {",
      "    assert.equal(Number.isInteger(oid) && oid > 0, true);",
      "  }",
      '  assert.equal(relationKind, "r");',
      "  assert.deepEqual(boundaryFacts, {"
    ].join("\n"),
    "OID result authentication"
  );
  assert.equal(latestHelper, expectedLatestHelper);
  for (const fragment of [
    "pg_catalog.pg_namespace namespace",
    "pg_catalog.pg_class relation",
    "member.oid, namespace.oid, 'USAGE'",
    "member.oid, relation.oid, 'SELECT'",
    "relation.relkind = 'r'",
    "member.oid IS NOT NULL",
    "namespace.oid IS NOT NULL",
    "relation.oid IS NOT NULL",
    "Number.isInteger(oid) && oid > 0",
    'assert.equal(relationKind, "r")'
  ]) assert.ok(latestHelper.includes(fragment), fragment);
  assert.ok(
    parentHelper.includes(
      "session_user, 'ia4tube_migrations.schema_migrations', 'SELECT'"
    )
  );
  assert.equal(
    latestHelper.includes(
      "session_user, 'ia4tube_migrations.schema_migrations', 'SELECT'"
    ),
    false
  );
  for (const forbidden of [
    /\berror\?\.(?:message|stack|detail|hint|where|schema|table|column|constraint)\b/,
    /\bString\(error/,
    /\bJSON\.stringify\(error/,
    /\bconsole\./,
    /\bprocess\.(?:stdout|stderr)\.write/,
    /\bcause\s*[:=]/,
    /\b(?:GRANT|REVOKE|ALTER\s+(?:ROLE|USER)|SET\s+SESSION\s+AUTHORIZATION)\b/i
  ]) assert.equal(forbidden.test(latestHelper), false, String(forbidden));
  assert.equal(latestSource.split(latestHelper).length - 1, 1);
  const normalizedLatest = latestSource.replace(latestHelper, parentHelper);
  assert.equal(normalizedLatest, ledgerPredecessorSource);

  const predecessorBytes = git([
    "cat-file",
    "blob",
    `${PERMISSION_BOUNDARY_COMMIT}:${REAL_TEST_FILE}`
  ], null);
  assert.ok(Buffer.isBuffer(predecessorBytes));
  assert.equal(
    crypto.createHash("sha256").update(predecessorBytes).digest("hex"),
    PERMISSION_BOUNDARY_REAL_TEST_LF_SHA256
  );
  assert.equal(
    gitBlobOid(predecessorBytes),
    PERMISSION_BOUNDARY_REAL_TEST_FILTERED_OID
  );

  const predecessorSource = predecessorBytes.toString("utf8");
  const currentSource = parentSource;
  const literals = (source) => [
    ...source.matchAll(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g
    )
  ].map((match) => match[0]);
  const compact = (source) => source.replace(/\s+/g, "");
  const replaceExactly = (source, before, after, count, label) => {
    assert.equal(source.split(before).length - 1, count, label);
    return source.split(before).join(after);
  };

  assert.equal(currentSource.split(helperSignature).length - 1, 1);
  assert.equal(predecessorSource.includes(helperSignature), false);
  const helper = inlineFunction(currentSource, helperSignature);
  for (const fragment of [
    "NOT member.rolinherit AS login_noinherit",
    "NOT membership.inherit_option AS membership_noinherit",
    "membership.set_option AS set_role_allowed",
    "direct_schema_usage_absent",
    "direct_ledger_select_absent",
    "await assert.rejects(",
    "migration_login_direct_ledger_refused",
    'error?.code === "42501" ? "42501" : "unknown"',
    "(client) => client.query(ledgerRead)",
    "{ role: MIGRATOR_ROLE }",
    "assert.equal(Number.isInteger(allowed.rows[0].ledger_count), true);"
  ]) assert.ok(helper.includes(fragment), fragment);
  assert.equal((helper.match(/\bpool\.query\(/g) || []).length, 2);
  assert.equal((helper.match(/\bwithTransaction\(/g) || []).length, 1);
  assert.equal((helper.match(/\bclient\.query\(ledgerRead\)/g) || []).length, 1);
  assert.equal((helper.match(/\bassert\.rejects\(/g) || []).length, 1);
  assert.ok(helper.indexOf("const boundary = await pool.query(") >= 0);
  assert.ok(
    helper.indexOf("const boundary = await pool.query(") <
      helper.indexOf("await assert.rejects(")
  );
  assert.ok(
    helper.indexOf("await assert.rejects(") <
      helper.indexOf("const allowed = await withTransaction(")
  );
  for (const forbidden of [
    /\berror\?\.(?:message|stack|detail|hint|where|schema|table|column|constraint)\b/,
    /\bString\(error/,
    /\bJSON\.stringify\(error/,
    /\bconsole\./,
    /\bprocess\.(?:stdout|stderr)\.write/,
    /\bcause\s*[:=]/,
    /\b(?:GRANT|REVOKE|ALTER\s+(?:ROLE|USER)|SET\s+SESSION\s+AUTHORIZATION)\b/i
  ]) assert.equal(forbidden.test(helper), false, String(forbidden));

  const snapshotSignature = "async function readExactCatalogSnapshot(pool) {";
  const predecessorSnapshot = inlineFunction(
    predecessorSource,
    snapshotSignature
  );
  const currentSnapshot = inlineFunction(currentSource, snapshotSignature);
  assert.deepEqual(literals(currentSnapshot), literals(predecessorSnapshot));
  let normalizedSnapshot = compact(currentSnapshot);
  normalizedSnapshot = replaceExactly(
    normalizedSnapshot,
    "withTransaction(pool,(client)=>client.query(",
    "pool.query(",
    1,
    "catalog snapshot transaction wrapper"
  );
  normalizedSnapshot = replaceExactly(
    normalizedSnapshot,
    "),{role:MIGRATOR_ROLE})",
    ")",
    1,
    "catalog snapshot migrator role"
  );
  assert.equal(normalizedSnapshot, compact(predecessorSnapshot));

  const routeSignature = "async function proveExact0004Route(";
  const predecessorRoute = inlineFunction(predecessorSource, routeSignature);
  const currentRoute = inlineFunction(currentSource, routeSignature);
  assert.deepEqual(literals(currentRoute), literals(predecessorRoute));
  let normalizedRoute = compact(currentRoute);
  normalizedRoute = replaceExactly(
    normalizedRoute,
    "awaitproveMigratorExplicitRoleBoundary(migrationPoolA);",
    "",
    1,
    "physical noinherit boundary call"
  );
  normalizedRoute = replaceExactly(
    normalizedRoute,
    "withTransaction(migrationPoolA,(client)=>client.query(",
    "migrationPoolA.query(",
    2,
    "rollback and final transaction wrappers"
  );
  normalizedRoute = replaceExactly(
    normalizedRoute,
    "),{role:MIGRATOR_ROLE})",
    ")",
    2,
    "rollback and final migrator roles"
  );
  assert.equal(normalizedRoute, compact(predecessorRoute));

  let reconstructed = currentSource;
  reconstructed = replaceExactly(
    reconstructed,
    `${helper}\n\n`,
    "",
    1,
    "authorized physical helper"
  );
  reconstructed = replaceExactly(
    reconstructed,
    currentSnapshot,
    predecessorSnapshot,
    1,
    "authorized catalog snapshot wrapper"
  );
  reconstructed = replaceExactly(
    reconstructed,
    currentRoute,
    predecessorRoute,
    1,
    "authorized exact route wrappers"
  );
  assert.equal(reconstructed, predecessorSource);
});

test("conflict Promise outcome is observed without changing the exact assertion", () => {
  const parentBytes = git([
    "cat-file",
    "blob",
    `${PARENT}:${REAL_TEST_FILE}`
  ], null);
  assert.ok(Buffer.isBuffer(parentBytes));
  assert.equal(
    crypto.createHash("sha256").update(parentBytes).digest("hex"),
    PARENT_REAL_TEST_LF_SHA256
  );
  assert.equal(gitBlobOid(parentBytes), PARENT_REAL_TEST_FILTERED_OID);
  const parentSource = parentBytes.toString("utf8");
  const currentBytes = canonicalLfBytes(REAL_TEST_FILE);
  assert.equal(
    crypto.createHash("sha256").update(currentBytes).digest("hex"),
    REAL_TEST_LF_SHA256
  );
  assert.equal(gitBlobOid(currentBytes), REAL_TEST_FILTERED_OID);
  const currentSource = currentBytes.toString("utf8");
  const staleExpectation = '      (error) => error?.code === "P0001"';
  const externalAccountExpectation =
    '      (error) => error?.code === "23514"';
  const observedExpectation = '        const matched = error?.code === "23514";';
  const observedAssertion = [
    "    physicalPhases.markExact0004ConflictingNegativeAttempted();",
    "    const observedConflictingNegativePromise =",
    "      physicalPhases.observeExact0004ConflictingNegative(",
    "        runnerA.applyExact(",
    "          EXACT_APPLY_REQUEST,",
    "          configuration.approvalEnvironment",
    "        )",
    "      );",
    "    await assert.rejects(",
    "      observedConflictingNegativePromise,",
    "      (error) => {",
    observedExpectation,
    "        physicalPhases.markExact0004ConflictingNegativeAssertionMatched(",
    "          matched",
    "        );",
    "        return matched;",
    "      }",
    "    );"
  ].join("\n");
  assert.equal(parentSource.includes(staleExpectation), false);
  assert.equal(parentSource.split(observedAssertion).length - 1, 1);
  assert.equal(currentSource.split(observedExpectation).length - 1, 1);
  assert.equal(currentSource.split(observedAssertion).length - 1, 1);
  assert.equal(parentSource.includes(externalAccountExpectation), false);
  assert.equal(currentSource.split(externalAccountExpectation).length - 1, 1);
  assert.equal(currentSource.includes(staleExpectation), false);

  const markerExpression =
    /physicalPhases\.(start|complete)Exact0004Subphase\(\s*"([^"]+)"\s*\)/g;
  const markers = [...currentSource.matchAll(markerExpression)].map((match) =>
    Object.freeze({ kind: match[1], subphase: match[2] })
  );
  assert.deepEqual(
    markers.filter(({ kind }) => kind === "start").map(({ subphase }) => subphase),
    EXACT0004_SUBPHASES.slice(0, -2)
  );
  assert.deepEqual(
    markers.filter(({ kind }) => kind === "complete").map(({ subphase }) => subphase),
    EXACT0004_SUBPHASES.slice(0, -2)
  );
  assert.equal((currentSource.match(/\bphysicalPhases\./g) || []).length, 70);
  assert.equal(
    currentSource.split("physicalPhases.markExact0004DatabaseMutationAttempted();")
      .length - 1,
    1
  );
  assert.ok(
    currentSource.indexOf(
      'physicalPhases.startExact0004Subphase("conflicting_0004_negative")'
    ) < currentSource.indexOf(
      "physicalPhases.markExact0004DatabaseMutationAttempted();"
    )
  );
  assert.ok(
    currentSource.indexOf(
      "physicalPhases.markExact0004DatabaseMutationAttempted();"
    ) < currentSource.indexOf("const conflictId = await insertExact0004Conflict(")
  );
  const conflictingStartIndex = currentSource.indexOf(
    'physicalPhases.startExact0004Subphase("conflicting_0004_negative")'
  );
  const conflictingCompleteIndex = currentSource.indexOf(
    'physicalPhases.completeExact0004Subphase(\n      "conflicting_0004_negative"'
  );
  assert.ok(conflictingStartIndex >= 0);
  assert.ok(conflictingCompleteIndex > conflictingStartIndex);
  const conflictingBlock = currentSource.slice(
    conflictingStartIndex,
    conflictingCompleteIndex
  );
  assert.equal(
    conflictingBlock.split(observedExpectation).length - 1,
    1
  );
  assert.equal(conflictingBlock.includes(staleExpectation), false);
  assert.equal(
    conflictingBlock.includes("social_connector_blocking_connection_conflict"),
    false
  );
  for (const forbidden of [
    "error.message",
    "error.stack",
    "error.detail",
    "error.hint",
    "error.where",
    "JSON.stringify(error)"
  ]) assert.equal(conflictingBlock.includes(forbidden), false, forbidden);
  assert.ok(
    conflictingBlock.indexOf("const conflictId = await insertExact0004Conflict(") <
      conflictingBlock.indexOf("runnerA.applyExact(")
  );
  for (const marker of [
    "physicalPhases.markExact0004ConflictingNegativeAttempted();",
    "physicalPhases.observeExact0004ConflictingNegative(",
    "physicalPhases.markExact0004ConflictingNegativeAssertionMatched("
  ]) assert.equal(conflictingBlock.split(marker).length - 1, 1, marker);
  assert.equal(conflictingBlock.split("runnerA.applyExact(").length - 1, 1);
  assert.ok(
    conflictingBlock.indexOf("physicalPhases.markExact0004ConflictingNegativeAttempted();") <
      conflictingBlock.indexOf("runnerA.applyExact(")
  );
  assert.ok(
    conflictingBlock.indexOf("runnerA.applyExact(") <
      conflictingBlock.indexOf("await assert.rejects(")
  );
  const rollbackStart = currentSource.indexOf(
    'physicalPhases.startExact0004Subphase("rollback_verification")'
  );
  const rollbackComplete = currentSource.indexOf(
    'physicalPhases.completeExact0004Subphase("rollback_verification")'
  );
  const externalStart = currentSource.indexOf(
    'physicalPhases.startExact0004Subphase(\n    "conflicting_external_account_0004_negative"'
  );
  const externalComplete = currentSource.indexOf(
    'physicalPhases.completeExact0004Subphase(\n      "conflicting_external_account_0004_negative"'
  );
  const externalRollbackStart = currentSource.indexOf(
    'physicalPhases.startExact0004Subphase(\n      "external_account_rollback_verification"'
  );
  const externalRollbackComplete = currentSource.indexOf(
    'physicalPhases.completeExact0004Subphase(\n    "external_account_rollback_verification"'
  );
  const positiveApply = currentSource.indexOf(
    'physicalPhases.startExact0004Subphase("apply_exact")'
  );
  assert.ok(conflictingCompleteIndex < rollbackStart);
  assert.ok(rollbackStart < rollbackComplete);
  assert.ok(rollbackComplete < externalStart);
  assert.ok(externalStart < externalComplete);
  assert.ok(externalComplete < externalRollbackStart);
  assert.ok(externalRollbackStart < externalRollbackComplete);
  assert.ok(externalRollbackComplete < positiveApply);
  const externalBlock = currentSource.slice(externalStart, externalRollbackComplete);
  for (const required of [
    "insertExact0004ExternalAccountConflict(",
    "countExact0004ActiveExternalAccounts(",
    "readExact0004OwnerExternalAccountVisibility(",
    'error?.code === "23514"',
    "social_connections_instagram_blocking_company_unique",
    "social_external_accounts_instagram_active_company_unique",
    "ledger_row_absent: true",
    "O rollback da 0004 deve preservar as duas contas conflitantes."
  ]) assert.equal(externalBlock.includes(required), true, required);
  for (const required of [
    "readExact0004OwnerConnectionVisibility(",
    "FORCE RLS deve ocultar do owner sem company_id as duas conexoes fisicas.",
    "O rollback da 0004 deve preservar as duas conexoes conflitantes."
  ]) assert.equal(currentSource.includes(required), true, required);
  assert.equal((currentSource.match(/\berror\?\.code === "23514"/g) || []).length, 2);
  for (const forbidden of [
    "error.message",
    "error.stack",
    "JSON.stringify(error)",
    "process.stdout.write",
    "process.stderr.write"
  ]) assert.equal(currentSource.includes(forbidden), false, forbidden);

  const helperStart = currentSource.indexOf(
    "async function countExact0004BlockingConnections("
  );
  const routeSignature = "async function proveExact0004Route(";
  const helperEnd = currentSource.indexOf(routeSignature, helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const authorizedHelpers = currentSource.slice(helperStart, helperEnd);
  for (const helper of [
    "countExact0004BlockingConnections",
    "readExact0004OwnerConnectionVisibility",
    "insertExact0004ExternalAccountConflict",
    "removeExact0004ExternalAccountConflict",
    "countExact0004ActiveExternalAccounts",
    "readExact0004OwnerExternalAccountVisibility"
  ]) assert.equal(authorizedHelpers.includes(`async function ${helper}(`), true);
  const withoutAuthorizedHelpers = currentSource.replace(authorizedHelpers, "");
  const currentRoute = inlineFunction(withoutAuthorizedHelpers, routeSignature);
  const parentRoute = inlineFunction(parentSource, routeSignature);
  assert.equal(
    withoutAuthorizedHelpers.replace(currentRoute, parentRoute),
    parentSource
  );
  for (const authorizedRouteProof of [
    "conflicting_external_account_0004_negative",
    "external_account_rollback_verification",
    "blocking_connection_index_absent",
    "active_account_index_absent",
    "index_catalog.indisunique",
    "index_catalog.indisvalid",
    "index_catalog.indisready",
    "connector_indexes"
  ]) assert.equal(currentRoute.includes(authorizedRouteProof), true);
});

test("instrumented runner pin is the canonical filtered LF blob", () => {
  const { workflow } = read();
  const guard = stepByName(
    job(workflow),
    "Verify immutable Exact20 contract"
  ).run;
  const { pins } = runnerPinMap(guard);
  assert.deepEqual(pins, { [RUNNER_FILE]: RUNNER_LF_SHA256 });
  const canonical = canonicalLfBytes(RUNNER_FILE);
  assert.equal(
    crypto.createHash("sha256").update(canonical).digest("hex"),
    RUNNER_LF_SHA256
  );
  assert.equal(gitBlobOid(canonical), RUNNER_FILTERED_OID);
  assert.equal(
    git(["hash-object", `--path=${RUNNER_FILE}`, "--", RUNNER_FILE]).trim(),
    RUNNER_FILTERED_OID
  );
  const parent = git([
    "cat-file",
    "blob",
    `${PARENT}:${RUNNER_FILE}`
  ], null);
  assert.ok(Buffer.isBuffer(parent));
  assert.equal(
    crypto.createHash("sha256").update(parent).digest("hex"),
    PARENT_RUNNER_LF_SHA256
  );
  assert.equal(gitBlobOid(parent), PARENT_RUNNER_FILTERED_OID);
  assert.notEqual(RUNNER_FILTERED_OID, PARENT_RUNNER_FILTERED_OID);
  const parentRunnerSource = parent.toString("utf8");
  assert.ok(parentRunnerSource.includes("const EVIDENCE_SCHEMA_VERSION = 5;"));
  assert.ok(parentRunnerSource.includes("conflictingNegativePromiseOutcome"));
  const runnerSource = canonical.toString("utf8");
  for (const fragment of [
    "const EVIDENCE_SCHEMA_VERSION = 6;",
    "EXACT_0004_SUBPHASES",
    "EXACT_0004_EXECUTION_SUBPHASES",
    "EXACT_0004_OPERATION_CLASSES",
    "EXACT_0004_ERROR_CLASSES",
    "EXACT_0004_EVIDENCE_FIELDS",
    "SAFE_SQL_STATES",
    "SAFE_SQL_STATE_VALUES",
    "POSTGRES_SQL_STATE",
    "CONFLICTING_NEGATIVE_PROMISE_OUTCOMES",
    "CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES",
    "conflictingNegativeEvidenceValid",
    "conflictingNegativeSucceeded",
    "emptyExact0004Evidence",
    "exact0004EvidenceValid",
    "exact0004OperationClass"
  ]) assert.ok(runnerSource.includes(fragment), fragment);
  for (const subphase of [
    "conflicting_external_account_0004_negative",
    "external_account_rollback_verification"
  ]) {
    assert.equal(runnerSource.split(`  "${subphase}",`).length - 1, 1);
    assert.equal(parentRunnerSource.includes(subphase), false);
  }
  assert.equal(
    runnerSource
      .replace("const EVIDENCE_SCHEMA_VERSION = 6;", "const EVIDENCE_SCHEMA_VERSION = 5;")
      .replace('  "conflicting_external_account_0004_negative",\n', "")
      .replace('  "external_account_rollback_verification",\n', "")
      .replace(
        '  conflicting_external_account_0004_negative: "negative_gate",\n',
        ""
      )
      .replace(
        '  external_account_rollback_verification: "rollback_check",\n',
        ""
      ),
    parentRunnerSource
  );
  const exactReporterArguments = [
    "        [",
    "          \"--test-reporter=tap\",",
    "          \"--test-reporter-destination=stdout\",",
    "          \"--test\",",
    "          path.resolve(__dirname, \"..\", \"tests\", \"social-postgres-real.test.js\")",
    "        ],"
  ].join("\n");
  assert.equal(runnerSource.split(exactReporterArguments).length - 1, 1);
  assert.equal(
    runnerSource.split("--test-reporter-destination=stdout").length - 1,
    1
  );
  for (const alternate of ["spec", "dot", "junit"]) {
    assert.equal(runnerSource.includes(`--test-reporter=${alternate}`), false);
  }
  assert.equal(
    runnerSource.includes("[\n          \"--test\",\n          path.resolve"),
    false
  );
});

test("Exact-0004 Linux workflow pins supply chain and installs once without scripts", () => {
  const { source, workflow } = read();
  const currentJob = job(workflow);
  assert.equal(currentJob["runs-on"], "ubuntu-24.04");
  assert.equal(currentJob["timeout-minutes"], 45);
  assert.equal(stepByName(currentJob, "Checkout authorized commit").uses, CHECKOUT);
  assert.deepEqual(stepByName(currentJob, "Checkout authorized commit").with, {
    "fetch-depth": 0,
    "persist-credentials": false
  });
  assert.equal(stepByName(currentJob, "Set up Node 24").uses, SETUP_NODE);
  assert.deepEqual(stepByName(currentJob, "Set up Node 24").with, {
    "node-version": "24",
    "package-manager-cache": false
  });
  assert.equal(
    stepByName(currentJob, "Install dependencies without lifecycle scripts").run,
    "npm ci --ignore-scripts --no-audit --no-fund"
  );
  assert.equal((source.match(/actions\/[a-z-]+@[0-9a-f]{40}/g) || []).length, 3);
  assert.equal(source.includes("@main"), false);
  assert.equal(source.includes("@master"), false);
});

test("one-shot proof reuses canonical Linux PostgreSQL with digest and no published port", () => {
  const { source, workflow } = read();
  const currentJob = job(workflow);
  const physical = stepByName(
    currentJob,
    "Run the one-shot PostgreSQL 18 Exact-0004 proof"
  );
  assert.equal(physical["continue-on-error"], true);
  assert.equal(physical.shell, "bash");
  for (const fragment of [
    "createLinuxPostgres",
    "createPoolMetricsRegistry",
    "persistentEnvironmentName",
    "delete process.env[name]",
    "refusedEnvironment.length!==0",
    "started.architecture!=='linux/amd64'",
    "started.networkInternal!==true",
    "started.publishedPortCount!==0",
    "started.noHostPortPublished!==true",
    "started.hostListenerAbsent!==true",
    "executable('docker')",
    "'{{.State.Pid}}'",
    "executable('nsenter')",
    "executable('env')",
    "'--target'",
    "'--net'",
    "'--setgid'",
    "'--setuid'",
    "'--preserve-env='",
    "'PATH='+env.PATH",
    "'HOME='+env.HOME",
    "detached:true",
    "SOCIAL_TEST_POSTGRES_APPROVED",
    "RUN_SOCIAL_POSTGRES_REAL_TESTS",
    "SOCIAL_TEST_TARGET_MODE",
    "SOCIAL_TEST_ENVIRONMENT_ID",
    "crypto.randomUUID()",
    "SOCIAL_TEST_PROVISIONER_DATABASE_URL",
    "SOCIAL_TEST_MIGRATION_DATABASE_URL",
    "SOCIAL_TEST_RUNTIME_DATABASE_URL",
    "ia4tube_social_test_",
    "postgresql://127.0.0.1:5432/",
    "shell:false",
    "profileBefore='0003'",
    "profileAfter='0004'",
    "verifyFinalProfile",
    "pg_catalog.pg_index",
    "indisunique",
    "indisvalid",
    "indisready",
    "social_connections_instagram_blocking_company_unique",
    "social_external_accounts_instagram_active_company_unique"
  ]) assert.ok(physical.run.includes(fragment), fragment);
  assert.equal((physical.run.match(/'run','test:postgres-real'/g) || []).length, 1);
  assert.equal((source.match(/npm run test:postgres-real/g) || []).length, 0);
  assert.equal(physical.run.includes("--publish"), false);
  assert.equal(physical.run.includes("--network host"), false);
  assert.equal(physical.run.includes("net.createServer"), false);
  assert.equal(physical.run.includes("proxy.listen"), false);
  assert.equal(physical.run.includes("proxyPort"), false);
  assert.equal(physical.run.includes("sudo -E"), false);
  const physicalEnvironment = physical.env || {};
  assert.equal(
    Object.prototype.hasOwnProperty.call(physicalEnvironment, "DATABASE_URL"),
    false
  );
  assert.deepEqual(
    Object.keys(physicalEnvironment).filter((name) =>
      /(?:RENDER|STAGING|PRODUCTION|DATABASE_URL)/.test(name)
    ),
    []
  );
  const expectedSyntheticDatabaseUrls = Object.freeze({
    SOCIAL_TEST_PROVISIONER_DATABASE_URL:
      "url(provisioner,provisionerPassword)",
    SOCIAL_TEST_MIGRATION_DATABASE_URL:
      "url(migration,migrationPassword)",
    SOCIAL_TEST_RUNTIME_DATABASE_URL: "url(runtime,runtimePassword)"
  });
  const assignedDatabaseUrlKeys = [...physical.run.matchAll(
    /(?:^|[,{])([A-Z][A-Z0-9_]*DATABASE_URL)\s*:/g
  )].map((match) => match[1]);
  assert.deepEqual(
    [...assignedDatabaseUrlKeys].sort(),
    Object.keys(expectedSyntheticDatabaseUrls).sort()
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      expectedSyntheticDatabaseUrls,
      "DATABASE_URL"
    ),
    false
  );
  assert.equal(/(?:^|[\n,{])\s*DATABASE_URL\s*:/.test(physical.run), false);
  for (const [name, value] of Object.entries(expectedSyntheticDatabaseUrls)) {
    assert.notEqual(value, "", name);
    assert.equal(
      physical.run.split(`${name}:${value}`).length - 1,
      1,
      name
    );
  }
  assert.ok(physical.run.includes("const env={}"));
  assert.equal(physical.run.includes("const env={...process.env}"), false);
  assert.equal(physical.run.includes(".render.com"), false);
  assert.equal(physical.run.includes("retry"), false);
  assert.ok(source.includes(IMAGE));
});

test("one-shot proof authenticates safe runner phases, TAP facts and first failure", () => {
  const { workflow } = read();
  const run = stepByName(
    job(workflow),
    "Run the one-shot PostgreSQL 18 Exact-0004 proof"
  ).run;
  for (const fragment of [
    "createSafeEventCollector",
    "EVIDENCE_SCHEMA_VERSION",
    "facts.protocolValid",
    "facts.closed",
    "facts.failure",
    "facts.eventCount",
    "planExactPassed=true",
    "applyExactPassed=true",
    "concurrencyPassed=true",
    "rollbackPassed=true",
    "firstFailure(code)",
    "1200s",
    "processGroupExists",
    "code===124||code===137",
    "'-KILL'",
    "result.facts"
  ]) assert.ok(run.includes(fragment), fragment);
  for (const expression of [
    /facts\.protocolValid===true/,
    /facts\.closed===true/,
    /facts\.failure===false/,
    /facts\.eventCount===9/,
    /evidence\.runnerReached===true/,
    /evidence\.gateValidated===true/,
    /evidence\.nodeTestSpawnAttempted===true/,
    /evidence\.nodeTestProcessCreated===true/,
    /evidence\.nodeTestExitCode===0/,
    /evidence\.nodeTestSignal===null/,
    /evidence\.nodeTestTimedOut===false/,
    /evidence\.tapStarted===true/,
    /evidence\.tapTitleObserved===true/,
    /evidence\.firstTestDiscovered===true/,
    /evidence\.stderrCategory===null/,
    /evidence\.safeErrorCode===null/,
    /evidence\.safeModuleName===null/,
    /evidence\.firstFailureStage===null/,
    /evidence\.lastMainPhaseStarted==='reauthentication'/,
    /evidence\.lastMainPhaseCompleted==='reauthentication'/,
    /evidence\.cleanupStarted===true/,
    /evidence\.cleanupCompleted===true/,
    /evidence\.failureDuringCleanup===false/,
    /evidence\.failurePhase===null/,
    /evidence\.safePermissionOrigin===null/,
    /evidence\.safeSourceBasename===null/,
    /evidence\.safeLineBucket===null/
  ]) assert.match(run, expression);
  assert.equal(
    (run.match(/createSafeEventCollector\(\)/g) || []).length,
    1
  );
  assert.match(run, /\.push\('stdout',chunk\)/);
  assert.match(run, /\.push\('stderr',chunk\)/);
  assert.equal(run.includes("IA4TUBE_SAFE_EVENT="), false);
  assert.equal(run.includes("StringDecoder"), false);
  assert.equal(run.includes("createTapParser"), false);
  assert.equal(run.includes("spawnSync"), false);
  assert.equal(run.includes("stdout +="), false);
  assert.equal(run.includes("stderr +="), false);
  assert.equal(run.includes("result.output"), false);
  assert.equal(run.includes("child.kill"), false);
});

test("cleanup is always, owned, fail-closed and evidence is exactly four regular files", () => {
  const { source, workflow } = read();
  const currentJob = job(workflow);
  const cleanup = stepByName(currentJob, "Cleanup owned PostgreSQL resources");
  const finalize = stepByName(currentJob, "Finalize sanitized four-file evidence");
  const upload = stepByName(currentJob, "Upload sanitized evidence");
  const enforcement = stepByName(currentJob, "Enforce final Exact-0004 result");
  assert.equal(cleanup.if, "always()");
  assert.equal(cleanup["continue-on-error"], true);
  assert.ok(cleanup.run.includes("createLinuxPostgres"));
  assert.ok(cleanup.run.includes(".cleanup()"));
  assert.equal(finalize.if, "always()");
  assert.ok(finalize.run.includes("stat.isFile()"));
  assert.ok(finalize.run.includes("stat.isSymbolicLink()"));
  assert.equal(upload.uses, UPLOAD);
  assert.equal(upload.with.name, "social-3b0-exact-0004-runner-linux-evidence");
  assert.deepEqual(upload.with.path.split("\n").map((file) => path.basename(file)), [
    "evidence.json",
    "evidence.json.sha256",
    "process-status.json",
    "process-status.json.sha256"
  ]);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(enforcement.if, "always()");
  assert.ok(enforcement.run.includes("Object.values(evidence.residuals)"));
  assert.ok(enforcement.run.includes("evidence.firstFailure!==null"));
  assert.ok(enforcement.run.includes("status.stdoutStored!==false"));
  assert.ok(enforcement.run.includes("status.stderrStored!==false"));
  assert.ok(enforcement.run.includes("fs.rmSync(directory"));
  assert.ok(enforcement.run.includes("execFileSync('git'"));
  assert.ok(enforcement.run.includes("worktree_not_clean"));
  assert.ok(enforcement.run.includes("worktreeFailure"));
  assert.ok(enforcement.run.includes("GIT_OPTIONAL_LOCKS:'0'"));
  assert.ok(enforcement.run.includes("GIT_TERMINAL_PROMPT:'0'"));
  assert.ok(enforcement.run.includes("timeout:20000"));
  assert.ok(enforcement.run.includes("maxBuffer:1024*1024"));
  assert.ok(finalize.run.includes("auxiliaryProcesses"));
  assert.ok(finalize.run.includes("validBoundary(value)"));
  assert.ok(enforcement.run.includes("validBoundary(evidence)"));
  assert.ok(
    finalize.run.includes(
      "evidence.cleanupCompleted===true&&cleanup&&cleanup.cleanupCompleted===true"
    )
  );
  const physical = stepByName(
    currentJob,
    "Run the one-shot PostgreSQL 18 Exact-0004 proof"
  );
  assert.ok(
    physical.run.includes(
      "evidence.cleanupCompleted===true&&cleanup&&cleanup.cleanupCompleted===true"
    )
  );
  assert.equal(source.includes("closeProxy"), false);
});

test("boundary validators reject weakened phase and diagnostic states", () => {
  const { workflow } = read();
  const currentJob = job(workflow);
  const runs = currentJob.steps
    .map((step) => step.run)
    .filter((run) => typeof run === "string" && run.includes("function validBoundary(value){"));

  assert.equal(runs.length, 2);
  const requiredGuards = [
    "const phaseDelta=startedIndex-completedIndex",
    "phaseDelta!==0&&phaseDelta!==1",
    "const mainActive=phaseDelta===1",
    "const allMainCompleted=startedIndex===mainPhases.length-1&&completedIndex===mainPhases.length-1",
    "typeof value.cleanupCompleted!=='boolean'",
    "value.cleanupStarted&&!mainActive&&!allMainCompleted",
    "value.cleanupCompleted&&!value.cleanupStarted",
    "value.failurePhase!==null&&value.failurePhase!=='final_cleanup'&&(!mainActive||value.failurePhase!==started)",
    "const failed=value.firstFailure!==null",
    "failed!==(value.firstFailureStage!==null)",
    "value.firstFailureStage==='test_execution'&&value.failurePhase===null",
    "value.stderrCategory==='permission_denied'&&value.failurePhase===null",
    "value.safePermissionOrigin!=='unknown'||value.safeSourceBasename!==null||value.safeLineBucket!=='unknown'",
    "!exact0004Subphases.has(exactStarted)",
    "value.planExactCompleted&&!value.planExactInvoked",
    "value.applyExactCompleted&&!value.applyExactInvoked",
    "value.applyExactInvoked&&!value.planExactCompleted",
    "value.applyExactInvoked&&!value.databaseMutationAttempted",
    "value.failureBeforeFirstMutation===value.databaseMutationAttempted",
    "(value.failurePhase==='exact_0004_plan_apply')!==(exactFailure!=='not_reached')",
    "exactStartedIndex<conflictIndex&&value.databaseMutationAttempted",
    "exactStartedIndex!==exactCompletedIndex+1",
    "const exactMainIndex=mainPhases.indexOf('exact_0004_plan_apply')",
    "const exactBefore=startedIndex<exactMainIndex",
    "const exactActive=startedIndex===exactMainIndex&&completedIndex===exactMainIndex-1",
    "const exactAfter=completedIndex>=exactMainIndex",
    "exactBefore&&!exactDefaults",
    "exactActive&&exactFailure==='not_reached'",
    "exactAfter&&!exactFinal",
  ];
  const weakenedGuards = [
    "completedIndex>startedIndex||startedIndex-completedIndex>1",
    "typeof value.cleanupStarted!=='boolean'||typeof value.failureDuringCleanup!=='boolean'",
    "else if(value.safePermissionOrigin!==null)return false",
    "value.cleanupCompleted&&!value.cleanupStarted&&!value.failureDuringCleanup",
  ];

  for (const run of runs) {
    for (const guard of requiredGuards) assert.ok(run.includes(guard), guard);
    for (const guard of weakenedGuards) assert.ok(!run.includes(guard), guard);
  }

  const allRuns = currentJob.steps.map((step) => step.run || "").join("\n");
  const validatorSignature = "function validBoundary(value){";
  assert.equal(allRuns.split(validatorSignature).length - 1, 2);
  const permissionOriginDeclaration =
    "const permissionOrigins=new Set(['postgres_sqlstate','os_filesystem','os_process','unknown']);";
  const permissionOriginExtraDeclaration =
    "const permissionOrigins=new Set(['postgres_sqlstate','os_filesystem','os_process','unknown','outside_allowlist']);";
  for (const run of runs) {
    assert.equal(run.split(permissionOriginDeclaration).length - 1, 1);
    assert.deepEqual(inlineClosedSet(run, "permissionOrigins"), PERMISSION_ORIGINS);
    assert.throws(() => boundaryValidator(run.replace(permissionOriginDeclaration, "")));
    assert.throws(() => boundaryValidator(
      run.replace(permissionOriginDeclaration, permissionOriginDeclaration.repeat(2))
    ));
    assert.throws(() => boundaryValidator(
      run.replace(permissionOriginDeclaration, permissionOriginExtraDeclaration)
    ));
  }
  const validators = runs.map(boundaryValidator);
  const boundaryBase = Object.freeze({
    lastMainPhaseStarted: "physical_target_preflight",
    lastMainPhaseCompleted: null,
    cleanupStarted: false,
    cleanupCompleted: false,
    failureDuringCleanup: false,
    failurePhase: null,
    firstFailure: "fixture_failure",
    firstFailureStage: "safe_event_protocol",
    stderrCategory: "permission_denied",
    safeErrorCode: "42501",
    safeModuleName: null,
    safePermissionOrigin: "postgres_sqlstate",
    safeSourceBasename: null,
    safeLineBucket: "unknown",
    lastExact0004SubphaseStarted: "not_reached",
    lastExact0004SubphaseCompleted: "not_reached",
    exact0004FailureSubphase: "not_reached",
    safeSqlState: "not_observed",
    safeErrorClass: "unknown",
    safeOperationClass: "unknown",
    planExactInvoked: false,
    planExactCompleted: false,
    applyExactInvoked: false,
    applyExactCompleted: false,
    databaseMutationAttempted: false,
    failureBeforeFirstMutation: false,
    ...CONFLICTING_NEGATIVE_DEFAULTS
  });
  const boundaryFixtures = Object.freeze([
    Object.freeze({
      label: "permission_without_phase",
      value: Object.freeze({ ...boundaryBase }),
      expected: false
    }),
    Object.freeze({
      label: "permission_with_allowlisted_phase",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight"
      }),
      expected: true
    }),
    Object.freeze({
      label: "pre_exact_sqlstate_is_not_exact_evidence",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight",
        safeSqlState: "42501",
        safeErrorClass: "postgres_sqlstate"
      }),
      expected: false
    }),
    Object.freeze({
      label: "pre_exact_progress_is_not_exact_evidence",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight",
        lastExact0004SubphaseStarted: "oid_catalog_lookup",
        exact0004FailureSubphase: "oid_catalog_lookup",
        safeSqlState: "unknown",
        safeOperationClass: "catalog_read",
        failureBeforeFirstMutation: true
      }),
      expected: false
    }),
    Object.freeze({
      label: "permission_42501_requires_postgres_sqlstate",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight"
      }),
      expected: true
    }),
    Object.freeze({
      label: "permission_eacces_with_authenticated_filesystem_origin",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight",
        safeErrorCode: "EACCES",
        safePermissionOrigin: "os_filesystem",
        safeSourceBasename: "migrations.js",
        safeLineBucket: "1-499",
        safeSqlState: "not_observed",
        safeErrorClass: "unknown"
      }),
      expected: true
    }),
    Object.freeze({
      label: "permission_eperm_with_authenticated_process_origin",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight",
        safeErrorCode: "EPERM",
        safePermissionOrigin: "os_process",
        safeSourceBasename: "server.js",
        safeLineBucket: "1-499",
        safeSqlState: "not_observed",
        safeErrorClass: "unknown"
      }),
      expected: true
    }),
    Object.freeze({
      label: "permission_without_origin_proof_is_unknown",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight",
        safeErrorCode: null,
        safePermissionOrigin: "unknown",
        safeSqlState: "not_observed",
        safeErrorClass: "unknown"
      }),
      expected: true
    }),
    Object.freeze({
      label: "permission_origin_outside_allowlist",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight",
        safePermissionOrigin: "outside_allowlist"
      }),
      expected: false
    }),
    Object.freeze({
      label: "permission_code_origin_conflict",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight",
        safePermissionOrigin: "os_filesystem"
      }),
      expected: false
    }),
    Object.freeze({
      label: "permission_with_unknown_phase",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "outside_allowlist"
      }),
      expected: false
    }),
    Object.freeze({
      label: "different_category_is_not_reclassified",
      value: Object.freeze({
        ...boundaryBase,
        stderrCategory: "reference_error",
        safeErrorCode: null,
        safePermissionOrigin: "unknown",
        safeSqlState: "not_observed",
        safeErrorClass: "unknown"
      }),
      expected: true
    })
  ]);
  for (const [validatorIndex, validate] of validators.entries()) {
    for (const fixture of boundaryFixtures) {
      const category = fixture.value.stderrCategory;
      assert.equal(
        validate(fixture.value),
        fixture.expected,
        `validator_${validatorIndex + 1}:${fixture.label}`
      );
      assert.equal(fixture.value.stderrCategory, category);
    }
  }
  for (const forbidden of ["rawLine", "rawStack", "stack", "message", "stdout", "stderr"]) {
    assert.equal(EVIDENCE_KEYS.includes(forbidden), false, forbidden);
    assert.equal(RUNNER_FACT_KEYS.includes(forbidden), false, forbidden);
  }
  assert.ok(allRuns.includes("safePermissionOrigin:'unknown',safeSourceBasename:null,safeLineBucket:'unknown'"));
  assert.ok(!allRuns.includes("safePermissionOrigin:null,safeSourceBasename:null,safeLineBucket:'unknown'"));

  const instrumentedGuard = currentJob.steps
    .map((step) => step.run)
    .find((run) => typeof run === "string" && run.includes("declare -A instrumented=("));
  assert.ok(instrumentedGuard);
  assert.ok(instrumentedGuard.includes('for file in "${!instrumented[@]}"; do'));
  assert.ok(instrumentedGuard.includes('sha256sum "$file"'));
});

test("Exact-0004 subphase artifact boundary is closed and mutation-coherent", () => {
  const { workflow } = read();
  const currentJob = job(workflow);
  const runs = currentJob.steps
    .map((step) => step.run)
    .filter((run) => typeof run === "string" && run.includes("function validBoundary(value){"));
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.deepEqual(
      inlineInventory(run, "exact0004Route"),
      EXACT0004_SUBPHASES.slice(0, -2)
    );
    assert.deepEqual(inlineClosedSet(run, "exact0004Subphases"), EXACT0004_SUBPHASES);
    assert.deepEqual(inlineClosedSet(run, "safeOperationClasses"), SAFE_OPERATION_CLASSES);
    assert.deepEqual(inlineClosedSet(run, "safeErrorClasses"), SAFE_ERROR_CLASSES);
    assert.deepEqual(inlineClosedSet(run, "safeSqlStates"), SAFE_SQL_STATES);
    assert.deepEqual(
      inlineClosedSet(run, "conflictingNegativePromiseOutcomes"),
      CONFLICTING_NEGATIVE_PROMISE_OUTCOMES
    );
    assert.deepEqual(
      inlineClosedSet(run, "conflictingNegativeFulfilledResultClasses"),
      CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES
    );
    assert.equal(
      run.split("const postgresSqlState=/^[0-9A-Z]{5}$/;").length - 1,
      1
    );
  }

  const validPlanFailure = Object.freeze({
    lastMainPhaseStarted: "exact_0004_plan_apply",
    lastMainPhaseCompleted: "migration_0003_apply",
    cleanupStarted: false,
    cleanupCompleted: false,
    failureDuringCleanup: false,
    failurePhase: "exact_0004_plan_apply",
    firstFailure: "real_postgres_test_failed",
    firstFailureStage: "test_execution",
    stderrCategory: "postgres_schema",
    safeErrorCode: "42501",
    safeModuleName: null,
    safePermissionOrigin: "unknown",
    safeSourceBasename: null,
    safeLineBucket: "unknown",
    lastExact0004SubphaseStarted: "plan_exact",
    lastExact0004SubphaseCompleted: "snapshot_before_plan",
    exact0004FailureSubphase: "plan_exact",
    safeSqlState: "42501",
    safeErrorClass: "postgres_sqlstate",
    safeOperationClass: "plan",
    planExactInvoked: true,
    planExactCompleted: false,
    applyExactInvoked: false,
    applyExactCompleted: false,
    databaseMutationAttempted: false,
    failureBeforeFirstMutation: true,
    ...CONFLICTING_NEGATIVE_DEFAULTS
  });
  const validAssertionFailure = Object.freeze({
    ...validPlanFailure,
    safeSqlState: "23514",
    safeErrorClass: "assertion_failure"
  });
  const validConflictFailure = Object.freeze({
    ...validPlanFailure,
    lastExact0004SubphaseStarted: "conflicting_0004_negative",
    lastExact0004SubphaseCompleted: "synthetic_0005_negative",
    exact0004FailureSubphase: "conflicting_0004_negative",
    safeSqlState: "unknown",
    safeErrorClass: "assertion_failure",
    safeOperationClass: "negative_gate",
    planExactCompleted: true,
    databaseMutationAttempted: true,
    failureBeforeFirstMutation: false,
    ...CONFLICTING_NEGATIVE_SUCCESS
  });
  const validExternalAccountFailure = Object.freeze({
    ...validConflictFailure,
    lastExact0004SubphaseStarted:
      "conflicting_external_account_0004_negative",
    lastExact0004SubphaseCompleted: "rollback_verification",
    exact0004FailureSubphase: "conflicting_external_account_0004_negative",
    safeSqlState: "23514"
  });
  const validExternalAccountRollbackFailure = Object.freeze({
    ...validConflictFailure,
    lastExact0004SubphaseStarted: "external_account_rollback_verification",
    lastExact0004SubphaseCompleted:
      "conflicting_external_account_0004_negative",
    exact0004FailureSubphase: "external_account_rollback_verification",
    safeSqlState: "P0001",
    safeErrorClass: "postgres_sqlstate",
    safeOperationClass: "rollback_check"
  });
  const validConflictOutcomes = Object.freeze([
    Object.freeze({
      label: "rejected_23514_matched",
      value: Object.freeze({ ...validConflictFailure })
    }),
    Object.freeze({
      label: "rejected_other_sqlstate_unmatched",
      value: Object.freeze({
        ...validConflictFailure,
        conflictingNegativeObservedSqlState: "40001",
        conflictingNegativeAssertionMatched: false
      })
    }),
    Object.freeze({
      label: "fulfilled_empty",
      value: Object.freeze({
        ...validConflictFailure,
        conflictingNegativePromiseOutcome: "fulfilled",
        conflictingNegativeObservedSqlState: "not_observed",
        conflictingNegativeFulfilledResultClass: "empty",
        conflictingNegativeAssertionMatched: null,
        conflictingNegativeRejectedBeforeAssertion: false
      })
    }),
    Object.freeze({
      label: "fulfilled_applied_0004",
      value: Object.freeze({
        ...validConflictFailure,
        conflictingNegativePromiseOutcome: "fulfilled",
        conflictingNegativeObservedSqlState: "not_observed",
        conflictingNegativeFulfilledResultClass: "applied_0004",
        conflictingNegativeAssertionMatched: null,
        conflictingNegativeRejectedBeforeAssertion: false
      })
    }),
    Object.freeze({
      label: "rejected_without_code_is_unknown",
      value: Object.freeze({
        ...validConflictFailure,
        conflictingNegativeObservedSqlState: "unknown",
        conflictingNegativeAssertionMatched: false
      })
    }),
    Object.freeze({
      label: "attempted_but_outcome_not_preserved_is_closed_unknown",
      value: Object.freeze({
        ...validConflictFailure,
        conflictingNegativePromiseOutcome: "unknown",
        conflictingNegativeObservedSqlState: "unknown",
        conflictingNegativeFulfilledResultClass: "unknown",
        conflictingNegativeAssertionMatched: null,
        conflictingNegativeRejectedBeforeAssertion: null
      })
    })
  ]);
  const validPostExactFailure = Object.freeze({
    ...validPlanFailure,
    lastMainPhaseStarted: "post_migration_validation",
    lastMainPhaseCompleted: "exact_0004_plan_apply",
    failurePhase: "post_migration_validation",
    stderrCategory: "tap_failure",
    safeErrorCode: "ERR_TEST_FAILURE",
    lastExact0004SubphaseStarted: "final_snapshot",
    lastExact0004SubphaseCompleted: "final_snapshot",
    exact0004FailureSubphase: "not_reached",
    safeSqlState: "not_observed",
    safeErrorClass: "unknown",
    safeOperationClass: "unknown",
    planExactCompleted: true,
    applyExactInvoked: true,
    applyExactCompleted: true,
    databaseMutationAttempted: true,
    failureBeforeFirstMutation: false,
    ...CONFLICTING_NEGATIVE_SUCCESS
  });
  const invalidMutations = Object.freeze([
    ["unknown_subphase", { lastExact0004SubphaseStarted: "outside_allowlist" }],
    ["completion_without_start", { planExactInvoked: false, planExactCompleted: true }],
    ["apply_without_plan", {
      lastExact0004SubphaseStarted: "apply_exact",
      lastExact0004SubphaseCompleted: "external_account_rollback_verification",
      exact0004FailureSubphase: "apply_exact",
      safeOperationClass: "apply",
      planExactInvoked: true,
      planExactCompleted: false,
      applyExactInvoked: true
    }],
    ["sqlstate_outside_allowlist", { safeSqlState: "XXXXX" }],
    ["operation_class_mismatch", { safeOperationClass: "schema_snapshot" }],
    ["mutation_boundary_conflict", {
      databaseMutationAttempted: true,
      failureBeforeFirstMutation: false
    }],
    ["completed_subphase_cannot_be_failure", {
      lastExact0004SubphaseCompleted: "plan_exact",
      planExactCompleted: true
    }],
    ["post_conflict_requires_mutation_marker", {
      lastExact0004SubphaseStarted: "rollback_verification",
      lastExact0004SubphaseCompleted: "conflicting_0004_negative",
      exact0004FailureSubphase: "rollback_verification",
      safeOperationClass: "rollback_check",
      databaseMutationAttempted: false,
      failureBeforeFirstMutation: true,
      planExactCompleted: true
    }],
    ["exact_main_failure_without_subphase", {
      exact0004FailureSubphase: "not_reached",
      safeSqlState: "not_observed",
      safeErrorClass: "unknown",
      safeOperationClass: "unknown",
      failureBeforeFirstMutation: false
    }],
    ["subphase_order_divergence", {
      lastExact0004SubphaseCompleted: "oid_catalog_lookup"
    }],
    ["invalid_observed_sqlstate", {
      ...validConflictFailure,
      conflictingNegativeObservedSqlState: "23-14"
    }],
    ["rejected_match_disagrees_with_sqlstate", {
      ...validConflictFailure,
      conflictingNegativeObservedSqlState: "40001",
      conflictingNegativeAssertionMatched: true
    }],
    ["fulfilled_cannot_store_sqlstate", {
      ...validConflictFailure,
      conflictingNegativePromiseOutcome: "fulfilled",
      conflictingNegativeFulfilledResultClass: "empty",
      conflictingNegativeAssertionMatched: null,
      conflictingNegativeRejectedBeforeAssertion: false
    }],
    ["fulfilled_cannot_store_raw_result_class", {
      ...validConflictFailure,
      conflictingNegativePromiseOutcome: "fulfilled",
      conflictingNegativeObservedSqlState: "not_observed",
      conflictingNegativeFulfilledResultClass: "raw_result",
      conflictingNegativeAssertionMatched: null,
      conflictingNegativeRejectedBeforeAssertion: false
    }]
  ]);
  for (const [index, validate] of runs.map(boundaryValidator).entries()) {
    assert.equal(validate(validPlanFailure), true, `validator_${index + 1}:valid`);
    assert.equal(
      validate(validAssertionFailure),
      true,
      `validator_${index + 1}:assertion_23514`
    );
    assert.equal(
      validate(validPostExactFailure),
      true,
      `validator_${index + 1}:post_exact`
    );
    assert.equal(
      validate(validExternalAccountFailure),
      true,
      `validator_${index + 1}:external_account_negative`
    );
    assert.equal(
      validate(validExternalAccountRollbackFailure),
      true,
      `validator_${index + 1}:external_account_rollback`
    );
    for (const fixture of validConflictOutcomes) {
      const firstFailure = fixture.value.firstFailure;
      assert.equal(
        validate(fixture.value),
        true,
        `validator_${index + 1}:${fixture.label}`
      );
      assert.equal(fixture.value.firstFailure, firstFailure);
    }
    for (const [label, mutation] of [
      ["post_exact_defaults", {
        lastExact0004SubphaseStarted: "not_reached",
        lastExact0004SubphaseCompleted: "not_reached",
        planExactInvoked: false,
        planExactCompleted: false,
        applyExactInvoked: false,
        applyExactCompleted: false,
        databaseMutationAttempted: false
      }],
      ["post_exact_sqlstate", {
        safeSqlState: "42501",
        safeErrorClass: "postgres_sqlstate"
      }],
      ["post_exact_apply_incomplete", { applyExactCompleted: false }]
    ]) {
      assert.equal(
        validate({ ...validPostExactFailure, ...mutation }),
        false,
        `validator_${index + 1}:${label}`
      );
    }
    for (const [label, mutation] of invalidMutations) {
      assert.equal(
        validate({ ...validPlanFailure, ...mutation }),
        false,
        `validator_${index + 1}:${label}`
      );
    }
  }
});

test("evidence keeps legacy schema 1 and uses the closed safe schema 6", () => {
  const { source, workflow } = read();
  const currentJob = job(workflow);
  const physical = stepByName(
    currentJob,
    "Run the one-shot PostgreSQL 18 Exact-0004 proof"
  );
  const finalize = stepByName(currentJob, "Finalize sanitized four-file evidence");
  const enforcement = stepByName(currentJob, "Enforce final Exact-0004 result");
  assert.equal(LEGACY_EVIDENCE_KEYS.length, 23);
  assert.equal(SAFE_EVIDENCE_KEYS.length, 23);
  assert.equal(EXACT0004_EVIDENCE_KEYS.length, 18);
  assert.equal(EVIDENCE_KEYS.length, 64);
  assert.equal(new Set(EVIDENCE_KEYS).size, 64);
  assert.equal(RUNNER_FACT_KEYS.length, 41);
  assert.equal(PROCESS_STATUS_KEYS.length, 5);
  const expectedEvidenceKeys = [...EVIDENCE_KEYS].sort();
  const expectedStatusKeys = [...PROCESS_STATUS_KEYS].sort();
  for (const [name, run] of [
    ["finalizer", finalize.run],
    ["enforcement", enforcement.run]
  ]) {
    const evidenceTuple = inlineArrayContaining(run, "evidenceSchemaVersion");
    const statusTuple = inlineArrayContaining(run, "stdoutStored");
    assert.deepEqual([...evidenceTuple.values].sort(), expectedEvidenceKeys, name);
    assert.deepEqual([...statusTuple.values].sort(), expectedStatusKeys, name);
    const valueName = name === "finalizer" ? "value" : "evidence";
    const statusName = name === "finalizer" ? "value" : "status";
    assertExactKeysCall(run, valueName, evidenceTuple.name);
    assertExactKeysCall(run, statusName, statusTuple.name);
    assert.match(run, new RegExp(`${valueName}\\.schemaVersion\\s*!==\\s*1`));
    assert.match(
      run,
      new RegExp(`${valueName}\\.evidenceSchemaVersion\\s*!==\\s*6`)
    );
    assert.match(
      run,
      new RegExp(
        `${valueName}\\.testFileLoaded\\s*!==\\s*` +
        `${valueName}\\.tapTitleObserved`
      )
    );
    for (const forbidden of [
      "protocolValid",
      "closed",
      "failure",
      "eventCount",
      "tapTests",
      "tapPass",
      "tapFail",
      "tapSkipped",
      "tapCancelled",
      "stdout",
      "stderr",
      "stack",
      "message",
      "query",
      "parameters",
      "detail",
      "hint",
      "where",
      "result",
      "rawResult",
      "absolutePath",
      "secret",
      "environment",
      "url",
      "password"
    ]) assert.equal(evidenceTuple.values.includes(forbidden), false, forbidden);
    for (const boundaryFragment of [
      "physical_target_preflight",
      "reauthentication",
      "final_cleanup",
      "postgres_sqlstate",
      "23514",
      "P0001",
      "os_filesystem",
      "os_process",
      "4000-4499",
      "final_snapshot",
      "failureBeforeFirstMutation",
      "conflictingNegativePromiseOutcome",
      "conflictingNegativeObservedSqlState",
      "conflictingNegativeFulfilledResultClass",
      "conflictingNegativeAssertionMatched",
      "conflictingNegativeRejectedBeforeAssertion",
      "validBoundary"
    ]) assert.ok(run.includes(boundaryFragment), `${name}:${boundaryFragment}`);
  }
  assert.ok(physical.run.includes("schemaVersion:1"));
  assert.ok(
    physical.run.includes(
      "evidenceSchemaVersion:EVIDENCE_SCHEMA_VERSION"
    )
  );
  assert.equal(physical.run.includes("schemaVersion:2"), false);
  assert.equal(physical.run.includes("schemaVersion:3"), false);
  const runnerFactTuple = inlineArrayContaining(physical.run, "runnerReached");
  assert.deepEqual(
    [...runnerFactTuple.values].sort(),
    [...RUNNER_FACT_KEYS].sort()
  );
  assert.ok(
    physical.run.includes(
      `for(const key of ${runnerFactTuple.name})evidence[key]=result.facts[key]`
    )
  );
  for (const nullable of [
    "testFileLoaded",
    "runnerReached",
    "gateValidated",
    "nodeTestSpawnAttempted",
    "nodeTestProcessCreated",
    "nodeTestExitCode",
    "nodeTestSignal",
    "nodeTestTimedOut",
    "tapStarted",
    "tapTitleObserved",
    "firstTestDiscovered",
    "stderrCategory",
    "safeErrorCode",
    "safeModuleName",
    "firstFailureStage",
    "lastMainPhaseStarted",
    "lastMainPhaseCompleted",
    "failurePhase",
    "safePermissionOrigin",
    "safeSourceBasename",
    "safeLineBucket",
    "conflictingNegativeAssertionMatched",
    "conflictingNegativeRejectedBeforeAssertion"
  ]) assert.ok(physical.run.includes(`${nullable}:null`), nullable);
  for (const booleanDefault of [
    "cleanupStarted",
    "cleanupCompleted",
    "failureDuringCleanup",
    "planExactInvoked",
    "planExactCompleted",
    "applyExactInvoked",
    "applyExactCompleted",
    "databaseMutationAttempted",
    "failureBeforeFirstMutation",
    "conflictingNegativeAttempted"
  ]) assert.ok(physical.run.includes(`${booleanDefault}:false`), booleanDefault);
  for (const defaultFragment of [
    "lastExact0004SubphaseStarted:'not_reached'",
    "lastExact0004SubphaseCompleted:'not_reached'",
    "exact0004FailureSubphase:'not_reached'",
    "safeSqlState:'not_observed'",
    "safeErrorClass:'unknown'",
    "safeOperationClass:'unknown'",
    "conflictingNegativePromiseOutcome:'not_started'",
    "conflictingNegativeObservedSqlState:'not_observed'",
    "conflictingNegativeFulfilledResultClass:'not_observed'"
  ]) {
    assert.ok(physical.run.includes(defaultFragment), `physical:${defaultFragment}`);
    assert.ok(finalize.run.includes(defaultFragment), `fallback:${defaultFragment}`);
  }
  assert.ok(
    physical.run.includes(
      "evidence.testFileLoaded=evidence.tapTitleObserved"
    )
  );
  assert.ok(physical.run.includes("evidence.testProcessStarted=true"));
  assert.equal(
    physical.run.includes(
      "evidence.testProcessStarted=result.facts.nodeTestProcessCreated"
    ),
    false
  );
  assert.ok(
    physical.run.includes(
      "evidence.testsDiscovered=evidence.firstTestDiscovered===true?1:0"
    )
  );
  assert.ok(physical.run.includes("evidence.testsPassed=passed?1:0"));
  assert.ok(physical.run.includes("evidence.testsFailed=passed?0:1"));
  assert.ok(physical.run.includes("result.facts.eventCount===9"));
  for (const successFragment of [
    "evidence.lastExact0004SubphaseStarted==='final_snapshot'",
    "evidence.lastExact0004SubphaseCompleted==='final_snapshot'",
    "evidence.exact0004FailureSubphase==='not_reached'",
    "evidence.safeSqlState==='not_observed'",
    "evidence.safeErrorClass==='unknown'",
    "evidence.safeOperationClass==='unknown'",
    "evidence.planExactInvoked===true",
    "evidence.planExactCompleted===true",
    "evidence.applyExactInvoked===true",
    "evidence.applyExactCompleted===true",
    "evidence.databaseMutationAttempted===true",
    "evidence.failureBeforeFirstMutation===false",
    "evidence.conflictingNegativeAttempted===true",
    "evidence.conflictingNegativePromiseOutcome==='rejected'",
    "evidence.conflictingNegativeObservedSqlState==='23514'",
    "evidence.conflictingNegativeFulfilledResultClass==='not_observed'",
    "evidence.conflictingNegativeAssertionMatched===true",
    "evidence.conflictingNegativeRejectedBeforeAssertion===true"
  ]) {
    assert.ok(physical.run.includes(successFragment), `physical:${successFragment}`);
    assert.ok(enforcement.run.includes(successFragment.replace("===", "!==")),
      `enforcement:${successFragment}`);
  }
  assert.ok(
    finalize.run.includes("evidenceSchemaVersion:6") &&
    finalize.run.includes("safeLineBucket:'unknown'")
  );
  assert.equal(source.includes("evidenceSchemaVersion:4"), false);
  assert.equal(source.includes("evidenceSchemaVersion:5"), false);
  assert.equal(source.includes("evidenceSchemaVersion:3"), false);
  for (const key of EVIDENCE_KEYS) assert.ok(source.includes(key), key);
  for (const key of PROCESS_STATUS_KEYS) assert.ok(source.includes(key), key);
  assert.equal(source.includes("process.env.DATABASE_URL"), false);
  assert.equal(source.includes("process.env.SOCIAL_MIGRATIONS_DATABASE_URL"), false);
  assert.equal(source.includes("process.env.PGPASSWORD"), false);
  assert.equal(source.includes("process.env.INSTAGRAM_APP_SECRET"), false);
});
