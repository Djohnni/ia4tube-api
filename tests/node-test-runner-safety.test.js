"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DEDICATED_GATE_TEST_FILES,
  PROCESS_LIFECYCLE_TEST_FILES,
  discoverAutomatedTests,
  main,
  partitionAutomatedTests,
  validateTestPartition
} = require("../scripts/run-node-tests");
const {
  CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES,
  CONFLICTING_NEGATIVE_PROMISE_OUTCOMES,
  EXACT_0004_ERROR_CLASSES,
  EXACT_0004_EVIDENCE_FIELDS,
  EXACT_0004_EXECUTION_SUBPHASES,
  EXACT_0004_OPERATION_CLASSES,
  EXACT_0004_SUBPHASES,
  SAFE_EVENT_PREFIX,
  SAFE_SQL_STATES,
  SAFE_SQL_STATE_VALUES,
  conflictingNegativeEvidenceValid,
  createPhysicalPhaseEmitter,
  emptyConflictingNegativeEvidence,
  emptyExact0004Evidence,
  exact0004EvidenceValid,
  exact0004OperationClass
} = require("../scripts/run-real-postgres-tests");

const PREVIOUS_SERIAL_FILES = Object.freeze([
  "body-parser-security.test.js",
  "checkpoint-a-security.test.js",
  "fcm-token-encryption.test.js",
  "social-2b0-config-security.test.js",
  "social-foundation-integration.test.js",
  "zip-downloads.test.js"
]);
const ADDED_WINDOWS_NATIVE_SERIAL_FILES = Object.freeze([
  "social-3a0p-local-file-replace-argument-powershell.test.js",
  "social-3a0p-local-file-replace-powershell-diagnostic.test.js",
  "social-3a0p-local-firewall-nonmutation.test.js",
  "social-3a0p-local-safe-zip-extract.test.js",
  "social-postgres-tls.test.js"
]);
const CURRENT_DIFF_SCOPE_SERIAL_FILE =
  "social-3a0p-current-diff-scope.test.js";
const EXPECTED_SERIAL_FILES = Object.freeze([
  ...PREVIOUS_SERIAL_FILES,
  ...ADDED_WINDOWS_NATIVE_SERIAL_FILES,
  CURRENT_DIFF_SCOPE_SERIAL_FILE
]);
const SYNTHETIC_TEST_DIRECTORY = path.resolve("synthetic-runner-tests");
const SYNTHETIC_REPOSITORY_ROOT = path.resolve("synthetic-runner-root");
const SYNTHETIC_EXECUTABLE = path.resolve("synthetic-node");
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const SAFE_EVIDENCE_COMMIT = "8534817574a22dbd144a835c9f3585c44ee11c96";
const PERMISSION_BOUNDARY_COMMIT = "555d71eacbde76ceffdd03d64731e03849978c17";
const REAL_POSTGRES_TEST = "tests/social-postgres-real.test.js";
const REAL_POSTGRES_TEST_LF_SHA256 =
  "d07054524efec8ac48b720eed8df7a39d2db6a8a5cda6249b80c30ec73b33a66";
const REAL_POSTGRES_TEST_FILTERED_OID =
  "926b6050fcb89b528126eb6fbf72f70624556a4b";
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

function directoryEntry(name, isFile = true) {
  return {
    name,
    isFile() {
      return isFile;
    }
  };
}

function fakeFilesystem(entries) {
  return {
    readdirSync(directory, options) {
      assert.equal(directory, SYNTHETIC_TEST_DIRECTORY);
      assert.deepEqual(options, { withFileTypes: true });
      return entries.map((entry) =>
        typeof entry === "string" ? directoryEntry(entry) : entry
      );
    }
  };
}

function defaultEntries(additional = ["ordinary-a.test.js", "ordinary-z.test.js"]) {
  return [
    ...additional.slice().reverse(),
    ...EXPECTED_SERIAL_FILES.slice().reverse(),
    "social-postgres-real.test.js",
    "not-a-test.js.txt",
    directoryEntry("directory.test.js", false)
  ];
}

function discover(entries = defaultEntries()) {
  return discoverAutomatedTests(SYNTHETIC_TEST_DIRECTORY, {
    fsImpl: fakeFilesystem(entries)
  });
}

function invokeRunner({
  entries = defaultEntries(),
  results = [{ status: 0 }, { status: 0 }],
  manifest = EXPECTED_SERIAL_FILES
} = {}) {
  const calls = [];
  const stderr = [];
  const environment = Object.freeze({ SYNTHETIC_RUNNER_ENVIRONMENT: "present" });
  let resultIndex = 0;
  const status = main({
    cwd: SYNTHETIC_REPOSITORY_ROOT,
    env: environment,
    execPath: SYNTHETIC_EXECUTABLE,
    fsImpl: fakeFilesystem(entries),
    processLifecycleTestFiles: manifest,
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      const result = results[resultIndex];
      resultIndex += 1;
      return result === undefined ? { status: 0 } : result;
    },
    stderr: {
      write(message) {
        stderr.push(String(message));
      }
    },
    testsDirectory: SYNTHETIC_TEST_DIRECTORY
  });
  return { calls, environment, status, stderr };
}

function testFileArguments(call) {
  return call.args.filter((argument) => argument.endsWith(".test.js"));
}

function replaceExactlyOnce(source, current, previous, label) {
  const first = source.indexOf(current);
  assert.notEqual(first, -1, label);
  assert.equal(source.indexOf(current, first + current.length), -1, label);
  return `${source.slice(0, first)}${previous}${source.slice(first + current.length)}`;
}

function closedSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, endMarker);
  return source.slice(start, end);
}

function assertOidBoundaryContract(source) {
  const exactFragments = [
    "NOT member.rolinherit AS login_noinherit",
    "NOT membership.inherit_option AS membership_noinherit",
    "membership.set_option AS set_role_allowed",
    "current_user = session_user AS login_role_active",
    "member.oid AS member_oid",
    "namespace.oid AS namespace_oid",
    "relation.oid AS relation_oid",
    "relation.relkind AS relation_kind",
    "NOT pg_catalog.has_schema_privilege(",
    "member.oid, namespace.oid, 'USAGE'",
    "NOT pg_catalog.has_table_privilege(",
    "member.oid, relation.oid, 'SELECT'",
    "JOIN pg_catalog.pg_roles member",
    "ON member.oid = membership.member",
    "JOIN pg_catalog.pg_namespace namespace",
    "ON namespace.nspname = 'ia4tube_migrations'",
    "JOIN pg_catalog.pg_class relation",
    "ON relation.relnamespace = namespace.oid",
    "AND relation.relname = 'schema_migrations'",
    "AND relation.relkind = 'r'",
    "AND member.rolname = session_user",
    "AND member.oid IS NOT NULL",
    "AND namespace.oid IS NOT NULL",
    "AND relation.oid IS NOT NULL",
    "assert.equal(boundary.rowCount, 1);",
    "assert.equal(Number.isInteger(oid) && oid > 0, true);",
    'assert.equal(relationKind, "r");',
    "await pool.query(ledgerRead);",
    'sanitized.code = error?.code === "42501" ? "42501" : "unknown";',
    '(error) => error?.code === "42501"',
    "return client.query(ledgerRead);",
    "{ role: MIGRATOR_ROLE }"
  ];
  for (const fragment of exactFragments) {
    assert.equal(source.split(fragment).length - 1, 1, fragment);
  }
  assert.equal(source.includes("::regclass"), false);
  assert.equal(source.includes("to_regclass"), false);
  assert.equal(
    source.includes(
      "session_user, 'ia4tube_migrations.schema_migrations', 'SELECT'"
    ),
    false
  );
  assert.equal((source.match(/\bpool\.query\(/g) || []).length, 2);
  assert.equal((source.match(/\bwithTransaction\(/g) || []).length, 1);
  const boundary = source.indexOf("const boundary = await pool.query(");
  const direct = source.indexOf("await pool.query(ledgerRead);");
  const allowed = source.indexOf("const allowed = await withTransaction(");
  assert.notEqual(boundary, -1);
  assert.equal(boundary < direct, true);
  assert.equal(direct < allowed, true);
}

test("1. automated test discovery remains deterministically ordered", () => {
  const discovered = discover([
    "zeta.test.js",
    "ignored.txt",
    directoryEntry("nested.test.js", false),
    "alpha.test.js"
  ]);
  assert.deepEqual(discovered, [
    path.join(SYNTHETIC_TEST_DIRECTORY, "alpha.test.js"),
    path.join(SYNTHETIC_TEST_DIRECTORY, "zeta.test.js")
  ]);
});

test("2. the ordinary runner keeps every dedicated physical gate excluded", () => {
  const discovered = discover(defaultEntries()).map((file) => path.basename(file));
  assert.deepEqual([...DEDICATED_GATE_TEST_FILES], ["social-postgres-real.test.js"]);
  assert.equal(discovered.includes("social-postgres-real.test.js"), false);
});

test("3. the closed serial manifest preserves eleven files and adds only current-diff scope", () => {
  const repositoryTests = discoverAutomatedTests(path.resolve(__dirname)).map((file) =>
    path.basename(file)
  );
  const previousManifest = [
    ...PREVIOUS_SERIAL_FILES,
    ...ADDED_WINDOWS_NATIVE_SERIAL_FILES
  ];
  const previousSet = new Set(previousManifest);
  assert.deepEqual(PROCESS_LIFECYCLE_TEST_FILES, EXPECTED_SERIAL_FILES);
  assert.equal(PROCESS_LIFECYCLE_TEST_FILES.length, 12);
  assert.deepEqual(
    PROCESS_LIFECYCLE_TEST_FILES.filter((name) => previousSet.has(name)),
    previousManifest
  );
  for (const name of ADDED_WINDOWS_NATIVE_SERIAL_FILES) {
    assert.equal(
      PROCESS_LIFECYCLE_TEST_FILES.filter((candidate) => candidate === name).length,
      1,
      name
    );
  }
  assert.equal(
    PROCESS_LIFECYCLE_TEST_FILES.filter(
      (candidate) => candidate === CURRENT_DIFF_SCOPE_SERIAL_FILE
    ).length,
    1
  );
  for (const name of EXPECTED_SERIAL_FILES) assert.ok(repositoryTests.includes(name), name);
});

test("4. a missing serial-manifest file is refused before process creation", () => {
  const discovered = discover(defaultEntries().filter(
    (entry) => entry !== EXPECTED_SERIAL_FILES[2]
  ));
  assert.throws(
    () => partitionAutomatedTests(discovered, EXPECTED_SERIAL_FILES),
    { code: "test_runner_serial_file_missing" }
  );
  const execution = invokeRunner({
    entries: defaultEntries().filter((entry) => entry !== EXPECTED_SERIAL_FILES[2])
  });
  assert.equal(execution.status, 1);
  assert.equal(execution.calls.length, 0);
});

test("5. a duplicated serial-manifest entry is refused", () => {
  const duplicate = [...EXPECTED_SERIAL_FILES, EXPECTED_SERIAL_FILES[0]];
  assert.throws(
    () => partitionAutomatedTests(discover(), duplicate),
    { code: "test_runner_serial_manifest_duplicate" }
  );
  const execution = invokeRunner({ manifest: duplicate });
  assert.equal(execution.status, 1);
  assert.equal(execution.calls.length, 0);
});

test("6. a file present in both execution stages is refused", () => {
  const file = path.join(SYNTHETIC_TEST_DIRECTORY, "one.test.js");
  assert.throws(
    () => validateTestPartition([file], [file], [file]),
    { code: "test_runner_partition_overlap" }
  );
});

test("7. an automated test omitted from both stages is refused", () => {
  const first = path.join(SYNTHETIC_TEST_DIRECTORY, "one.test.js");
  const omitted = path.join(SYNTHETIC_TEST_DIRECTORY, "two.test.js");
  assert.throws(
    () => validateTestPartition([first, omitted], [first], []),
    { code: "test_runner_partition_incomplete" }
  );
});

test("8. the serial stage receives test concurrency one and the closed order", () => {
  const { calls, status } = invokeRunner();
  assert.equal(status, 0);
  assert.deepEqual(calls[0].args, [
    "--test",
    "--test-concurrency=1",
    ...EXPECTED_SERIAL_FILES.map((name) => path.join(SYNTHETIC_TEST_DIRECTORY, name))
  ]);
});

test("9. the concurrent stage preserves the current command without a concurrency flag", () => {
  const { calls, status } = invokeRunner();
  assert.equal(status, 0);
  assert.deepEqual(calls[1].args, [
    "--test",
    path.join(SYNTHETIC_TEST_DIRECTORY, "ordinary-a.test.js"),
    path.join(SYNTHETIC_TEST_DIRECTORY, "ordinary-z.test.js")
  ]);
  assert.equal(calls[1].args.includes("--test-concurrency=1"), false);
});

test("10. a serial-stage failure short-circuits the concurrent stage", () => {
  const execution = invokeRunner({ results: [{ status: 7 }, { status: 0 }] });
  assert.equal(execution.status, 7);
  assert.equal(execution.calls.length, 1);
});

test("11. a concurrent-stage failure status is returned unchanged", () => {
  const execution = invokeRunner({ results: [{ status: 0 }, { status: 9 }] });
  assert.equal(execution.status, 9);
  assert.equal(execution.calls.length, 2);
});

test("12. a spawn result carrying an error fails closed", () => {
  const execution = invokeRunner({
    results: [{ error: Object.assign(new Error("synthetic"), { code: "ENOENT" }), status: null }]
  });
  assert.equal(execution.status, 1);
  assert.equal(execution.calls.length, 1);
});

test("13. a null child status fails closed", () => {
  const execution = invokeRunner({ results: [{ status: null }] });
  assert.equal(execution.status, 1);
  assert.equal(execution.calls.length, 1);
});

test("14. both stages preserve the repository cwd exactly", () => {
  const { calls } = invokeRunner();
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.options.cwd, SYNTHETIC_REPOSITORY_ROOT);
});

test("15. both stages preserve the exact process environment reference", () => {
  const { calls, environment } = invokeRunner();
  assert.equal(calls.length, 2);
  for (const call of calls) assert.strictEqual(call.options.env, environment);
});

test("16. both stages keep stdio inherited", () => {
  const { calls } = invokeRunner();
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.options.stdio, "inherit");
});

test("17. a failed stage is never retried", () => {
  const execution = invokeRunner({
    results: [{ status: 4 }, { status: 0 }, { status: 0 }]
  });
  assert.equal(execution.status, 4);
  assert.equal(execution.calls.length, 1);
});

test("18. a successful run executes each of the two stages only once", () => {
  const execution = invokeRunner({
    results: [{ status: 0 }, { status: 0 }, { status: 0 }]
  });
  assert.equal(execution.status, 0);
  assert.equal(execution.calls.length, 2);
  assert.notDeepEqual(execution.calls[0].args, execution.calls[1].args);
});

test("19. the runner adds no process timeout", () => {
  const { calls } = invokeRunner();
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(Object.hasOwn(call.options, "timeout"), false);
});

test("20. the runner never enables a shell", () => {
  const { calls } = invokeRunner();
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(Object.hasOwn(call.options, "shell"), false);
});

test("21. executable and arguments remain separate with an argument array", () => {
  const { calls } = invokeRunner();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.executable, SYNTHETIC_EXECUTABLE);
    assert.equal(Array.isArray(call.args), true);
    assert.equal(call.args[0], "--test");
  }
});

test("22. every discovered automated test is executed exactly once", () => {
  const discovered = discover();
  const { calls } = invokeRunner();
  const counts = new Map();
  for (const file of calls.flatMap(testFileArguments)) {
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  assert.deepEqual([...counts.keys()].sort(), discovered);
  for (const file of discovered) assert.equal(counts.get(file), 1, file);
});

test("23. partitioning preserves the exact total automated-test count", () => {
  const discovered = discover();
  const plan = partitionAutomatedTests(discovered, EXPECTED_SERIAL_FILES);
  assert.equal(plan.serial.length + plan.concurrent.length, discovered.length);
  const { calls } = invokeRunner();
  assert.equal(calls.flatMap(testFileArguments).length, discovered.length);
});

test("24. exact 0004 production ledger reads use the migrator role only", () => {
  const migrationsPath = path.join(
    REPOSITORY_ROOT,
    "src",
    "persistence",
    "postgres",
    "migrations.js"
  );
  const realTestPath = path.join(
    REPOSITORY_ROOT,
    "tests",
    "social-postgres-real.test.js"
  );
  const migrationsSource = fs.readFileSync(migrationsPath, "utf8")
    .replaceAll("\r\n", "\n");
  const rawRealTest = fs.readFileSync(realTestPath, "utf8");
  const realTestSource = rawRealTest.replaceAll("\r\n", "\n");
  assert.equal(migrationsSource.includes("\r"), false);
  assert.equal(realTestSource.includes("\r"), false);

  const roleBoundaryHelper = closedSourceSection(
    realTestSource,
    "async function proveMigratorExplicitRoleBoundary(pool, physicalPhases) {",
    "async function readExactCatalogSnapshot(pool) {"
  );
  const authorizedRoleBoundaryHelper = String.raw`async function proveMigratorExplicitRoleBoundary(pool) {
  const boundary = await pool.query(
    [
      "SELECT",
      "  NOT member.rolinherit AS login_noinherit,",
      "  NOT membership.inherit_option AS membership_noinherit,",
      "  membership.set_option AS set_role_allowed,",
      "  current_user = session_user AS login_role_active,",
      "  member.oid AS member_oid,",
      "  namespace.oid AS namespace_oid,",
      "  relation.oid AS relation_oid,",
      "  relation.relkind AS relation_kind,",
      "  NOT pg_catalog.has_schema_privilege(",
      "    member.oid, namespace.oid, 'USAGE'",
      "  ) AS direct_schema_usage_absent,",
      "  NOT pg_catalog.has_table_privilege(",
      "    member.oid, relation.oid, 'SELECT'",
      "  ) AS direct_ledger_select_absent",
      "FROM pg_catalog.pg_auth_members membership",
      "JOIN pg_catalog.pg_roles granted",
      "  ON granted.oid = membership.roleid",
      "JOIN pg_catalog.pg_roles member",
      "  ON member.oid = membership.member",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.nspname = 'ia4tube_migrations'",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.relnamespace = namespace.oid",
      "  AND relation.relname = 'schema_migrations'",
      "  AND relation.relkind = 'r'",
      "WHERE granted.rolname = $1",
      "  AND member.rolname = session_user",
      "  AND member.oid IS NOT NULL",
      "  AND namespace.oid IS NOT NULL",
      "  AND relation.oid IS NOT NULL"
    ].join("\n"),
    [MIGRATOR_ROLE]
  );
  assert.equal(boundary.rowCount, 1);
  const {
    member_oid: memberOid,
    namespace_oid: namespaceOid,
    relation_oid: relationOid,
    relation_kind: relationKind,
    ...boundaryFacts
  } = boundary.rows[0];
  for (const oid of [memberOid, namespaceOid, relationOid]) {
    assert.equal(Number.isInteger(oid) && oid > 0, true);
  }
  assert.equal(relationKind, "r");
  assert.deepEqual(boundaryFacts, {
    login_noinherit: true,
    membership_noinherit: true,
    set_role_allowed: true,
    login_role_active: true,
    direct_schema_usage_absent: true,
    direct_ledger_select_absent: true
  });

  const ledgerRead =
    "SELECT COUNT(*)::integer AS ledger_count " +
    "FROM ia4tube_migrations.schema_migrations";
  await assert.rejects(
    async () => {
      try {
        await pool.query(ledgerRead);
      } catch (error) {
        const sanitized = new Error("migration_login_direct_ledger_refused");
        sanitized.code = error?.code === "42501" ? "42501" : "unknown";
        throw sanitized;
      }
    },
    (error) => error?.code === "42501"
  );
  const allowed = await withTransaction(
    pool,
    (client) => client.query(ledgerRead),
    { role: MIGRATOR_ROLE }
  );
  assert.equal(allowed.rowCount, 1);
  assert.equal(Number.isInteger(allowed.rows[0].ledger_count), true);
}

`;
  const roleBoundaryInstrumentationReplacements = [
    {
      label: "role boundary observational parameter",
      current:
        "async function proveMigratorExplicitRoleBoundary(pool, physicalPhases) {",
      previous: "async function proveMigratorExplicitRoleBoundary(pool) {"
    },
    {
      label: "OID catalog lookup start",
      current:
        '  physicalPhases.startExact0004Subphase("oid_catalog_lookup");\n',
      previous: ""
    },
    {
      label: "OID catalog lookup completion",
      current:
        '  physicalPhases.completeExact0004Subphase("oid_catalog_lookup");\n',
      previous: ""
    },
    {
      label: "privilege boolean check start",
      current: [
        "  physicalPhases.startExact0004Subphase(",
        '    "direct_privilege_boolean_check"',
        "  );"
      ].join("\n") + "\n",
      previous: ""
    },
    {
      label: "privilege boolean check completion",
      current: [
        "  physicalPhases.completeExact0004Subphase(",
        '    "direct_privilege_boolean_check"',
        "  );"
      ].join("\n") + "\n",
      previous: ""
    },
    {
      label: "direct ledger negative start",
      current:
        '  physicalPhases.startExact0004Subphase("direct_ledger_read_negative");\n',
      previous: ""
    },
    {
      label: "direct ledger negative completion",
      current:
        '  physicalPhases.completeExact0004Subphase("direct_ledger_read_negative");\n',
      previous: ""
    },
    {
      label: "role switch start",
      current:
        '  physicalPhases.startExact0004Subphase("set_local_migrator_role");\n',
      previous: ""
    },
    {
      label: "role switch and role ledger callback boundary",
      current: [
        "    (client) => {",
        '      physicalPhases.completeExact0004Subphase("set_local_migrator_role");',
        '      physicalPhases.startExact0004Subphase("role_ledger_read_positive");',
        "      return client.query(ledgerRead);",
        "    },"
      ].join("\n"),
      previous: "    (client) => client.query(ledgerRead),"
    },
    {
      label: "role ledger positive completion",
      current:
        '  physicalPhases.completeExact0004Subphase("role_ledger_read_positive");\n',
      previous: ""
    }
  ];
  let roleBoundaryBaseline = roleBoundaryHelper;
  for (const { current, previous, label } of
    roleBoundaryInstrumentationReplacements) {
    roleBoundaryBaseline = replaceExactlyOnce(
      roleBoundaryBaseline,
      current,
      previous,
      label
    );
  }
  assert.equal(roleBoundaryBaseline, authorizedRoleBoundaryHelper);

  const snapshotSource = closedSourceSection(
    realTestSource,
    "async function readExactCatalogSnapshot(pool) {",
    "async function insertExact0004Conflict(pool, fixture) {"
  );
  const exactRouteSource = closedSourceSection(
    realTestSource,
    "async function proveExact0004Route(",
    "function tenantFixture(label) {"
  );
  const productionSnapshotSource = `${snapshotSource}${exactRouteSource}`;
  assert.equal(
    (productionSnapshotSource.match(
      /ia4tube_migrations\.schema_migrations/g
    ) || []).length,
    3
  );
  assert.equal(
    snapshotSource.startsWith(
      [
        "async function readExactCatalogSnapshot(pool) {",
        "  const result = await withTransaction(",
        "    pool,",
        "    (client) => client.query("
      ].join("\n")
    ),
    true
  );
  assert.equal(
    (snapshotSource.match(/\{ role: MIGRATOR_ROLE \}/g) || []).length,
    1
  );
  assert.equal(snapshotSource.includes("await pool.query("), false);
  assert.equal(
    exactRouteSource.includes(
      "const rollbackState = await migrationPoolA.query("
    ),
    false
  );
  assert.equal(
    exactRouteSource.includes("const final = await migrationPoolA.query("),
    false
  );
  assert.equal(
    (exactRouteSource.match(/\{ role: MIGRATOR_ROLE \}/g) || []).length,
    2
  );
  assert.equal(
    (exactRouteSource.match(/\brunnerA\.planExact\(/g) || []).length,
    2
  );
  assert.equal(
    (exactRouteSource.match(/\bfutureRunner\.planExact\(/g) || []).length,
    1
  );
  assert.equal(
    (exactRouteSource.match(/\brunnerA\.applyExact\(/g) || []).length,
    2
  );
  assert.equal(
    (exactRouteSource.match(/\brunnerB\.applyExact\(/g) || []).length,
    1
  );
  const boundaryCall = exactRouteSource.indexOf(
    "  await proveMigratorExplicitRoleBoundary(migrationPoolA, physicalPhases);"
  );
  const firstSnapshot = exactRouteSource.indexOf(
    "  const beforePlan = await readExactCatalogSnapshot(migrationPoolA);"
  );
  const firstPlan = exactRouteSource.indexOf(
    "  const plan = await runnerA.planExact("
  );
  assert.notEqual(boundaryCall, -1);
  assert.equal(boundaryCall < firstSnapshot, true);
  assert.equal(firstSnapshot < firstPlan, true);

  const authorizedPermissionReplacements = [
    {
      label: "closed explicit-role negative",
      current: roleBoundaryHelper,
      previous: ""
    },
    {
      label: "negative invocation before the first snapshot",
      current:
        "  await proveMigratorExplicitRoleBoundary(migrationPoolA, physicalPhases);\n",
      previous: ""
    },
    {
      label: "catalog snapshot explicit-role opening",
      current: [
        "async function readExactCatalogSnapshot(pool) {",
        "  const result = await withTransaction(",
        "    pool,",
        "    (client) => client.query(",
        "      ["
      ].join("\n"),
      previous: [
        "async function readExactCatalogSnapshot(pool) {",
        "  const result = await pool.query(",
        "    ["
      ].join("\n")
    },
    {
      label: "catalog snapshot explicit-role closing",
      current: [
        "      ].join(\"\\n\"),",
        "      [[\"ia4tube_migrations\", \"ia4tube_social\", \"ia4tube_social_admin\"]]",
        "    ),",
        "    { role: MIGRATOR_ROLE }",
        "  );"
      ].join("\n"),
      previous: [
        "    ].join(\"\\n\"),",
        "    [[\"ia4tube_migrations\", \"ia4tube_social\", \"ia4tube_social_admin\"]]",
        "  );"
      ].join("\n")
    },
    {
      label: "rollback snapshot explicit-role opening",
      current: [
        "    const rollbackState = await withTransaction(",
        "      migrationPoolA,",
        "      (client) => client.query(",
        "        ["
      ].join("\n"),
      previous: [
        "    const rollbackState = await migrationPoolA.query(",
        "      ["
      ].join("\n")
    },
    {
      label: "rollback snapshot explicit-role closing",
      current: [
        "        ].join(\"\\n\"),",
        "        [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION]",
        "      ),",
        "      { role: MIGRATOR_ROLE }",
        "    );"
      ].join("\n"),
      previous: [
        "      ].join(\"\\n\"),",
        "      [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION]",
        "    );"
      ].join("\n")
    },
    {
      label: "final snapshot explicit-role opening",
      current: [
        "  const final = await withTransaction(",
        "    migrationPoolA,",
        "    (client) => client.query(",
        "      ["
      ].join("\n"),
      previous: [
        "  const final = await migrationPoolA.query(",
        "    ["
      ].join("\n")
    },
    {
      label: "final snapshot explicit-role closing",
      current: [
        "      ].join(\"\\n\"),",
        "      [",
        "        SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,",
        "        [",
        "          \"social_idempotency_operations\",",
        "          \"social_publications\",",
        "          \"social_publication_attempts\"",
        "        ]",
        "      ]",
        "    ),",
        "    { role: MIGRATOR_ROLE }",
        "  );"
      ].join("\n"),
      previous: [
        "    ].join(\"\\n\"),",
        "    [",
        "      SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,",
        "      [",
        "        \"social_idempotency_operations\",",
        "        \"social_publications\",",
        "        \"social_publication_attempts\"",
        "      ]",
        "    ]",
        "  );"
      ].join("\n")
    }
  ];
  assert.equal(
    /\b(?:GRANT|REVOKE|CREATE\s+(?:ROLE|USER)|ALTER\s+(?:ROLE|USER))\b/i.test(
      authorizedPermissionReplacements.map(({ current }) => current).join("\n")
    ),
    false
  );
  const exactRouteInstrumentationReplacements = [
    {
      label: "exact route observational parameter",
      current: [
        "  companyWithLegacyConnection,",
        "  physicalPhases",
        ") {"
      ].join("\n"),
      previous: [
        "  companyWithLegacyConnection",
        ") {"
      ].join("\n")
    },
    {
      label: "exact route observational argument",
      current: [
        "          configuration,",
        "          companyC,",
        "          physicalPhases",
        "        ));"
      ].join("\n"),
      previous: [
        "          configuration,",
        "          companyC",
        "        ));"
      ].join("\n")
    }
  ];
  const exact0004Instrumentation = [
    '  physicalPhases.startExact0004Subphase("snapshot_before_plan");\n',
    '  physicalPhases.completeExact0004Subphase("snapshot_before_plan");\n',
    '  physicalPhases.startExact0004Subphase("plan_exact");\n',
    '  physicalPhases.completeExact0004Subphase("plan_exact");\n',
    '  physicalPhases.startExact0004Subphase("plan_snapshot_compare");\n',
    '  physicalPhases.completeExact0004Subphase("plan_snapshot_compare");\n',
    '  physicalPhases.startExact0004Subphase("synthetic_0005_negative");\n',
    '  physicalPhases.completeExact0004Subphase("synthetic_0005_negative");\n',
    '  physicalPhases.startExact0004Subphase("conflicting_0004_negative");\n',
    "  physicalPhases.markExact0004DatabaseMutationAttempted();\n",
    [
      "    physicalPhases.completeExact0004Subphase(",
      '      "conflicting_0004_negative"',
      "    );"
    ].join("\n") + "\n",
    '    physicalPhases.startExact0004Subphase("rollback_verification");\n',
    '  physicalPhases.completeExact0004Subphase("rollback_verification");\n',
    '  physicalPhases.startExact0004Subphase("apply_exact");\n',
    '  physicalPhases.completeExact0004Subphase("apply_exact");\n',
    '  physicalPhases.startExact0004Subphase("concurrency");\n',
    '  physicalPhases.completeExact0004Subphase("concurrency");\n',
    '  physicalPhases.startExact0004Subphase("final_snapshot");\n',
    '  physicalPhases.completeExact0004Subphase("final_snapshot");\n'
  ];
  const conflictingNegativeOutcomeReplacement = {
    current: [
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
      '        const matched = error?.code === "23514";',
      "        physicalPhases.markExact0004ConflictingNegativeAssertionMatched(",
      "          matched",
      "        );",
      "        return matched;",
      "      }",
      "    );"
    ].join("\n"),
    previous: [
      "    await assert.rejects(",
      "      runnerA.applyExact(",
      "        EXACT_APPLY_REQUEST,",
      "        configuration.approvalEnvironment",
      "      ),",
      '      (error) => error?.code === "23514"',
      "    );"
    ].join("\n")
  };
  let permissionBoundaryCandidate = replaceExactlyOnce(
    realTestSource,
    conflictingNegativeOutcomeReplacement.current,
    conflictingNegativeOutcomeReplacement.previous,
    "conflicting negative outcome observation"
  );
  permissionBoundaryCandidate = replaceExactlyOnce(
    permissionBoundaryCandidate,
    '      (error) => error?.code === "23514"',
    '      (error) => error?.code === "P0001"',
    "canonical conflict SQLSTATE expectation"
  );
  for (const { current, previous, label } of authorizedPermissionReplacements) {
    permissionBoundaryCandidate = replaceExactlyOnce(
      permissionBoundaryCandidate,
      current,
      previous,
      label
    );
  }
  let permissionBoundaryHistoricalCandidate = permissionBoundaryCandidate;
  for (const { current, previous, label } of
    exactRouteInstrumentationReplacements) {
    permissionBoundaryHistoricalCandidate = replaceExactlyOnce(
      permissionBoundaryHistoricalCandidate,
      current,
      previous,
      label
    );
  }
  for (const line of exact0004Instrumentation) {
    permissionBoundaryHistoricalCandidate = replaceExactlyOnce(
      permissionBoundaryHistoricalCandidate,
      line,
      "",
      line.trim()
    );
  }
  const permissionBoundaryHistorical = execFileSync(
    "git",
    [
      "cat-file",
      "blob",
      `${PERMISSION_BOUNDARY_COMMIT}:${REAL_POSTGRES_TEST}`
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: null,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0"
      }
    }
  );
  assert.deepEqual(
    Buffer.from(permissionBoundaryHistoricalCandidate, "utf8"),
    permissionBoundaryHistorical
  );

  const exportBlock = /module\.exports\s*=\s*\{([^{}]*)\};/.exec(
    migrationsSource
  );
  assert.ok(exportBlock);
  assert.equal(
    (exportBlock[1].match(/\bGLOBAL_VAULT_REGISTRY_MIGRATION\b/g) || []).length,
    1
  );
  const importBlock = /const \{([^{}]*)\} = require\("\.\.\/src\/persistence\/postgres\/migrations"\);/.exec(
    realTestSource
  );
  assert.ok(importBlock);
  const importedNames = importBlock[1].split(",").map((name) => name.trim());
  assert.equal(
    importedNames.filter((name) => name === "GLOBAL_VAULT_REGISTRY_MIGRATION").length,
    1
  );
  assert.equal(
    (realTestSource.match(/\bGLOBAL_VAULT_REGISTRY_MIGRATION\b/g) || []).length,
    4
  );
  const sourceWithoutBinding = permissionBoundaryCandidate.replace(
    "  GLOBAL_VAULT_REGISTRY_MIGRATION,\n",
    ""
  );
  assert.equal(
    /\b(?:const|let|var)\s+GLOBAL_VAULT_REGISTRY_MIGRATION\b/.test(
      sourceWithoutBinding
    ),
    false
  );
  for (const expression of [
    /\(item\) => item\.version === GLOBAL_VAULT_REGISTRY_MIGRATION/,
    /\(migration\) => migration\.version === GLOBAL_VAULT_REGISTRY_MIGRATION/,
    /\[GLOBAL_VAULT_REGISTRY_MIGRATION\]/
  ]) assert.equal((sourceWithoutBinding.match(expression) || []).length, 1);
  assert.equal(realTestSource.includes("0003_global_vault_key_registry"), false);
  assert.equal(
    realTestSource.split("  GLOBAL_VAULT_REGISTRY_MIGRATION,\n").length - 1,
    1
  );

  const expectedMarkers = PHYSICAL_MAIN_PHASES.flatMap((phase) => [
    `startMain:${phase}`,
    `completeMain:${phase}`
  ]).concat(["startCleanup", "completeCleanup"]);
  const observedMarkers = [
    ...realTestSource.matchAll(
      /^      physicalPhases\.(?:(startMain|completeMain)\("([a-z0-9_]+)"\)|(startCleanup|completeCleanup)\(\));$/gm
    )
  ].map((match) => match[1] ? `${match[1]}:${match[2]}` : match[3]);
  assert.equal(PHYSICAL_MAIN_PHASES.length, 16);
  assert.equal(expectedMarkers.length, 34);
  assert.deepEqual(observedMarkers, expectedMarkers);
  assert.equal(
    (realTestSource.match(/\bphysicalPhases\./g) || []).length,
    66
  );
  assert.equal(
    (realTestSource.match(/\bcreatePhysicalPhaseEmitter\b/g) || []).length,
    2
  );

  const authorizedInstrumentation = [
    "  createPhysicalPhaseEmitter,\n",
    "    const physicalPhases = createPhysicalPhaseEmitter();\n",
    ...PHYSICAL_MAIN_PHASES.flatMap((phase) => [
      `      physicalPhases.startMain("${phase}");\n`,
      `      physicalPhases.completeMain("${phase}");\n`
    ]),
    ...exact0004Instrumentation,
    "      physicalPhases.startCleanup();\n",
    "      physicalPhases.completeCleanup();\n"
  ];
  let baselineCandidate = sourceWithoutBinding;
  for (const { current, previous, label } of
    exactRouteInstrumentationReplacements) {
    baselineCandidate = replaceExactlyOnce(
      baselineCandidate,
      current,
      previous,
      label
    );
  }
  for (const line of authorizedInstrumentation) {
    assert.equal(baselineCandidate.split(line).length - 1, 1, line.trim());
    baselineCandidate = baselineCandidate.replace(line, "");
  }

  const historical = execFileSync(
    "git",
    ["cat-file", "blob", `${SAFE_EVIDENCE_COMMIT}:${REAL_POSTGRES_TEST}`],
    {
      cwd: REPOSITORY_ROOT,
      encoding: null,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0"
      }
    }
  );
  assert.deepEqual(Buffer.from(baselineCandidate, "utf8"), historical);
  const canonical = Buffer.from(realTestSource, "utf8");
  assert.equal(
    crypto.createHash("sha256").update(canonical).digest("hex"),
    REAL_POSTGRES_TEST_LF_SHA256
  );
  const filteredOid = execFileSync(
    "git",
    ["hash-object", `--path=${REAL_POSTGRES_TEST}`, "--", REAL_POSTGRES_TEST],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0"
      }
    }
  ).trim();
  assert.equal(filteredOid, REAL_POSTGRES_TEST_FILTERED_OID);
});

test("25. exact 0004 NOINHERIT boundary refuses direct ledger reads without raw error leakage", () => {
  const realTestPath = path.join(
    REPOSITORY_ROOT,
    "tests",
    "social-postgres-real.test.js"
  );
  const poolPath = path.join(
    REPOSITORY_ROOT,
    "src",
    "persistence",
    "postgres",
    "pool.js"
  );
  const realTestSource = fs.readFileSync(realTestPath, "utf8")
    .replaceAll("\r\n", "\n");
  const poolSource = fs.readFileSync(poolPath, "utf8")
    .replaceAll("\r\n", "\n");
  assert.equal(realTestSource.includes("\r"), false);
  assert.equal(poolSource.includes("\r"), false);

  const roleBoundaryHelper = closedSourceSection(
    realTestSource,
    "async function proveMigratorExplicitRoleBoundary(pool, physicalPhases) {",
    "async function readExactCatalogSnapshot(pool) {"
  );
  assertOidBoundaryContract(roleBoundaryHelper);
  for (const contract of [
    "NOT member.rolinherit AS login_noinherit",
    "NOT membership.inherit_option AS membership_noinherit",
    "membership.set_option AS set_role_allowed",
    "current_user = session_user AS login_role_active",
    "member.oid, namespace.oid, 'USAGE'",
    "member.oid, relation.oid, 'SELECT'",
    "WHERE granted.rolname = $1",
    "AND member.rolname = session_user",
    "[MIGRATOR_ROLE]",
    "login_noinherit: true",
    "membership_noinherit: true",
    "set_role_allowed: true",
    "login_role_active: true",
    "direct_schema_usage_absent: true",
    "direct_ledger_select_absent: true"
  ]) assert.equal(roleBoundaryHelper.includes(contract), true, contract);
  assert.equal(
    (roleBoundaryHelper.match(/\bawait assert\.rejects\(/g) || []).length,
    1
  );
  assert.equal(
    (roleBoundaryHelper.match(/\bawait pool\.query\(ledgerRead\)/g) || []).length,
    1
  );
  assert.equal(
    roleBoundaryHelper.includes(
      'sanitized.code = error?.code === "42501" ? "42501" : "unknown";'
    ),
    true
  );
  assert.equal(
    roleBoundaryHelper.includes('(error) => error?.code === "42501"'),
    true
  );
  assert.equal(
    (roleBoundaryHelper.match(/return client\.query\(ledgerRead\);/g) || []).length,
    1
  );
  assert.equal(
    (roleBoundaryHelper.match(/\{ role: MIGRATOR_ROLE \}/g) || []).length,
    1
  );
  assert.equal(roleBoundaryHelper.includes("assert.equal(allowed.rowCount, 1);"), true);
  const directRead = roleBoundaryHelper.indexOf("await pool.query(ledgerRead);");
  const roleRead = roleBoundaryHelper.indexOf("const allowed = await withTransaction(");
  assert.notEqual(directRead, -1);
  assert.equal(directRead < roleRead, true);

  for (const rawErrorSurface of [
    /error\??\.message\b/,
    /error\??\.stack\b/,
    /error\??\.detail\b/,
    /error\??\.hint\b/,
    /error\??\.where\b/,
    /\bString\(error\)/,
    /\bJSON\.stringify\(error\)/,
    /\bconsole\./,
    /\bthrow\s+error\b/,
    /\bcause\s*[:=]/
  ]) assert.equal(rawErrorSurface.test(roleBoundaryHelper), false, rawErrorSurface);
  assert.equal(
    /\b(?:GRANT|REVOKE|CREATE\s+(?:ROLE|USER)|ALTER\s+(?:ROLE|USER))\b/i.test(
      roleBoundaryHelper
    ),
    false
  );

  const withTransactionSource = closedSourceSection(
    poolSource,
    "async function withTransaction(pool, operation, options = {}) {",
    "async function verifyRuntimeRole(pool, role) {"
  );
  assert.equal(
    withTransactionSource.includes(
      "await client.query(`SET LOCAL ROLE ${quoteIdentifier(options.role)}`);"
    ),
    true
  );
});

test("26. exact 0004 ledger OID boundary rejects incomplete or textual contracts", () => {
  const realTestSource = fs.readFileSync(
    path.join(REPOSITORY_ROOT, "tests", "social-postgres-real.test.js"),
    "utf8"
  ).replaceAll("\r\n", "\n");
  const source = closedSourceSection(
    realTestSource,
    "async function proveMigratorExplicitRoleBoundary(pool, physicalPhases) {",
    "async function readExactCatalogSnapshot(pool) {"
  );
  assertOidBoundaryContract(source);
  const replace = (before, after) =>
    replaceExactlyOnce(source, before, after, before);
  const mutations = [
    ["role absent", replace("      \"  AND member.rolname = session_user\",\n", "")],
    [
      "role duplicated",
      replace(
        "      \"  AND member.rolname = session_user\",\n",
        "      \"  AND member.rolname = session_user\",\n      \"  AND member.rolname = session_user\",\n"
      )
    ],
    ["schema absent", replace("      \"  ON namespace.nspname = 'ia4tube_migrations'\",\n", "")],
    [
      "schema duplicated",
      replace(
        "      \"  ON namespace.nspname = 'ia4tube_migrations'\",\n",
        "      \"  ON namespace.nspname = 'ia4tube_migrations'\",\n      \"  ON namespace.nspname = 'ia4tube_migrations'\",\n"
      )
    ],
    ["relation absent", replace("      \"  AND relation.relname = 'schema_migrations'\",\n", "")],
    [
      "relation duplicated",
      replace(
        "      \"  AND relation.relname = 'schema_migrations'\",\n",
        "      \"  AND relation.relname = 'schema_migrations'\",\n      \"  AND relation.relname = 'schema_migrations'\",\n"
      )
    ],
    [
      "relkind divergent",
      replace(
        "      \"  AND relation.relkind = 'r'\",",
        "      \"  AND relation.relkind = 'v'\","
      )
    ],
    [
      "member OID null guard removed",
      replace(
        "      \"  AND member.oid IS NOT NULL\",\n",
        ""
      )
    ],
    [
      "namespace OID null guard removed",
      replace(
        "      \"  AND namespace.oid IS NOT NULL\",\n",
        ""
      )
    ],
    [
      "relation OID null guard removed",
      replace(
        "      \"  AND relation.oid IS NOT NULL\"\n",
        ""
      )
    ],
    [
      "textual privilege resolution",
      replace(
        "      \"    member.oid, relation.oid, 'SELECT'\",",
        "      \"    session_user, 'ia4tube_migrations.schema_migrations', 'SELECT'\","
      )
    ],
    [
      "direct negative removed",
      replace("        await pool.query(ledgerRead);", "        await Promise.resolve();")
    ],
    ["positive role removed", replace("    { role: MIGRATOR_ROLE }", "    {}")]
  ];
  for (const [label, mutated] of mutations) {
    assert.throws(
      () => assertOidBoundaryContract(mutated),
      (error) => error?.code === "ERR_ASSERTION",
      label
    );
  }
});

test("27. exact 0004 plan subphase evidence stays closed and observational", async () => {
  const conflictingNegativeEvidenceFields = [
    "conflictingNegativeAttempted",
    "conflictingNegativePromiseOutcome",
    "conflictingNegativeObservedSqlState",
    "conflictingNegativeFulfilledResultClass",
    "conflictingNegativeAssertionMatched",
    "conflictingNegativeRejectedBeforeAssertion"
  ];
  const evidenceFields = [
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
    ...conflictingNegativeEvidenceFields
  ];
  const executionSubphases = [
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
    "apply_exact",
    "concurrency",
    "final_snapshot"
  ];
  const operationClasses = [
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
  ];
  const errorClasses = [
    "postgres_sqlstate",
    "assertion_failure",
    "environment_contract",
    "process_failure",
    "timeout",
    "unexpected_result",
    "unknown"
  ];
  const promiseOutcomes = [
    "not_started",
    "fulfilled",
    "rejected",
    "unknown"
  ];
  const fulfilledResultClasses = [
    "not_observed",
    "empty",
    "applied_0004",
    "other",
    "unknown"
  ];
  assert.deepEqual(EXACT_0004_EVIDENCE_FIELDS, evidenceFields);
  assert.deepEqual(EXACT_0004_EXECUTION_SUBPHASES, executionSubphases);
  assert.deepEqual(
    EXACT_0004_SUBPHASES,
    [...executionSubphases, "unknown", "not_reached"]
  );
  assert.deepEqual(EXACT_0004_OPERATION_CLASSES, operationClasses);
  assert.deepEqual(EXACT_0004_ERROR_CLASSES, errorClasses);
  assert.deepEqual(
    CONFLICTING_NEGATIVE_PROMISE_OUTCOMES,
    promiseOutcomes
  );
  assert.deepEqual(
    CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES,
    fulfilledResultClasses
  );
  assert.deepEqual(SAFE_SQL_STATES, ["42501", "23514", "P0001"]);
  assert.deepEqual(
    SAFE_SQL_STATE_VALUES,
    ["42501", "23514", "P0001", "unknown", "not_observed"]
  );
  assert.equal(new Set(EXACT_0004_EVIDENCE_FIELDS).size, 18);
  assert.equal(new Set(EXACT_0004_SUBPHASES).size, 16);
  for (const forbidden of [
    "message",
    "stack",
    "detail",
    "hint",
    "where",
    "query",
    "parameters",
    "stdout",
    "stderr"
  ]) {
    assert.equal(evidenceFields.includes(forbidden), false, forbidden);
  }

  const emptyConflictingNegative = emptyConflictingNegativeEvidence();
  assert.deepEqual(emptyConflictingNegative, {
    conflictingNegativeAttempted: false,
    conflictingNegativePromiseOutcome: "not_started",
    conflictingNegativeObservedSqlState: "not_observed",
    conflictingNegativeFulfilledResultClass: "not_observed",
    conflictingNegativeAssertionMatched: null,
    conflictingNegativeRejectedBeforeAssertion: null
  });
  assert.equal(Object.isFrozen(emptyConflictingNegative), true);
  assert.equal(
    conflictingNegativeEvidenceValid(emptyConflictingNegative),
    true
  );

  const empty = emptyExact0004Evidence();
  assert.deepEqual(empty, {
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
    ...emptyConflictingNegative
  });
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(exact0004EvidenceValid(empty), true);

  const successful = {
    ...empty,
    lastExact0004SubphaseStarted: "final_snapshot",
    lastExact0004SubphaseCompleted: "final_snapshot",
    planExactInvoked: true,
    planExactCompleted: true,
    applyExactInvoked: true,
    applyExactCompleted: true,
    databaseMutationAttempted: true,
    conflictingNegativeAttempted: true,
    conflictingNegativePromiseOutcome: "rejected",
    conflictingNegativeObservedSqlState: "23514",
    conflictingNegativeFulfilledResultClass: "not_observed",
    conflictingNegativeAssertionMatched: true,
    conflictingNegativeRejectedBeforeAssertion: true
  };
  assert.equal(exact0004EvidenceValid(successful), true);
  const rejectedDifferentSqlState = {
    ...emptyConflictingNegative,
    conflictingNegativeAttempted: true,
    conflictingNegativePromiseOutcome: "rejected",
    conflictingNegativeObservedSqlState: "P0001",
    conflictingNegativeAssertionMatched: false,
    conflictingNegativeRejectedBeforeAssertion: true
  };
  const rejectedWithoutCode = {
    ...rejectedDifferentSqlState,
    conflictingNegativeObservedSqlState: "unknown"
  };
  const fulfilledEmpty = {
    ...emptyConflictingNegative,
    conflictingNegativeAttempted: true,
    conflictingNegativePromiseOutcome: "fulfilled",
    conflictingNegativeFulfilledResultClass: "empty",
    conflictingNegativeRejectedBeforeAssertion: false
  };
  const fulfilledApplied0004 = {
    ...fulfilledEmpty,
    conflictingNegativeFulfilledResultClass: "applied_0004"
  };
  const unknownOutcome = {
    ...emptyConflictingNegative,
    conflictingNegativeAttempted: true,
    conflictingNegativePromiseOutcome: "unknown",
    conflictingNegativeObservedSqlState: "unknown",
    conflictingNegativeFulfilledResultClass: "unknown"
  };
  for (const valid of [
    {
      ...emptyConflictingNegative,
      conflictingNegativeAttempted: true,
      conflictingNegativePromiseOutcome: "rejected",
      conflictingNegativeObservedSqlState: "23514",
      conflictingNegativeAssertionMatched: true,
      conflictingNegativeRejectedBeforeAssertion: true
    },
    rejectedDifferentSqlState,
    rejectedWithoutCode,
    fulfilledEmpty,
    fulfilledApplied0004,
    { ...fulfilledEmpty, conflictingNegativeFulfilledResultClass: "other" },
    { ...fulfilledEmpty, conflictingNegativeFulfilledResultClass: "unknown" },
    unknownOutcome
  ]) assert.equal(conflictingNegativeEvidenceValid(valid), true);
  for (const invalid of [
    { ...emptyConflictingNegative, conflictingNegativeAttempted: true },
    {
      ...rejectedDifferentSqlState,
      conflictingNegativePromiseOutcome: "outside_enum"
    },
    {
      ...rejectedDifferentSqlState,
      conflictingNegativeObservedSqlState: "invalid_sqlstate"
    },
    {
      ...rejectedDifferentSqlState,
      conflictingNegativeFulfilledResultClass: "other"
    },
    {
      ...rejectedDifferentSqlState,
      conflictingNegativeAssertionMatched: true
    },
    {
      ...rejectedDifferentSqlState,
      conflictingNegativeRejectedBeforeAssertion: false
    },
    {
      ...fulfilledEmpty,
      conflictingNegativeObservedSqlState: "23514"
    },
    {
      ...fulfilledEmpty,
      conflictingNegativeFulfilledResultClass: "not_observed"
    },
    {
      ...fulfilledEmpty,
      conflictingNegativeAssertionMatched: false
    },
    {
      ...unknownOutcome,
      conflictingNegativeRejectedBeforeAssertion: true
    }
  ]) assert.equal(conflictingNegativeEvidenceValid(invalid), false);
  const beforeFirstMutationFailure = {
    ...emptyExact0004Evidence({ failureObserved: true }),
    lastExact0004SubphaseStarted: "plan_exact",
    lastExact0004SubphaseCompleted: "snapshot_before_plan",
    exact0004FailureSubphase: "plan_exact",
    safeErrorClass: "assertion_failure",
    safeOperationClass: "plan",
    planExactInvoked: true,
    failureBeforeFirstMutation: true
  };
  assert.equal(
    exact0004EvidenceValid(beforeFirstMutationFailure, {
      failureEvent: true
    }),
    true
  );
  assert.equal(exact0004OperationClass("plan_exact"), "plan");
  assert.equal(exact0004OperationClass("not_reached"), "unknown");
  for (const invalid of [
    { ...successful, planExactInvoked: false },
    { ...successful, applyExactInvoked: false },
    { ...successful, databaseMutationAttempted: false },
    { ...successful, failureBeforeFirstMutation: true },
    { ...successful, conflictingNegativeAttempted: false },
    { ...successful, conflictingNegativePromiseOutcome: "fulfilled" },
    { ...successful, conflictingNegativeObservedSqlState: "P0001" },
    { ...successful, conflictingNegativeFulfilledResultClass: "other" },
    { ...successful, conflictingNegativeAssertionMatched: false },
    { ...successful, conflictingNegativeRejectedBeforeAssertion: false },
    { ...successful, safeSqlState: "42P01" },
    {
      ...beforeFirstMutationFailure,
      safeSqlState: "unknown",
      safeErrorClass: "postgres_sqlstate"
    },
    {
      ...beforeFirstMutationFailure,
      safeOperationClass: "schema_snapshot"
    }
  ]) assert.equal(exact0004EvidenceValid(invalid), false);

  const realTestSource = fs.readFileSync(
    path.join(REPOSITORY_ROOT, ...REAL_POSTGRES_TEST.split("/")),
    "utf8"
  ).replaceAll("\r\n", "\n");
  assert.equal(realTestSource.includes("\r"), false);
  const observedCalls = [
    ...realTestSource.matchAll(
      /physicalPhases\.(startExact0004Subphase|completeExact0004Subphase)\(\s*"([a-z0-9_]+)"\s*\);/g
    )
  ].map((match) => ({
    index: match.index,
    kind: match[1],
    subphase: match[2]
  }));
  assert.deepEqual(
    observedCalls.map(({ kind, subphase }) => `${kind}:${subphase}`),
    executionSubphases.flatMap((subphase) => [
      `startExact0004Subphase:${subphase}`,
      `completeExact0004Subphase:${subphase}`
    ])
  );
  assert.equal(
    realTestSource.split(
      "physicalPhases.markExact0004DatabaseMutationAttempted();"
    ).length - 1,
    1
  );
  const conflictingStart = observedCalls.find(
    ({ kind, subphase }) =>
      kind === "startExact0004Subphase" &&
      subphase === "conflicting_0004_negative"
  );
  const conflictingComplete = observedCalls.find(
    ({ kind, subphase }) =>
      kind === "completeExact0004Subphase" &&
      subphase === "conflicting_0004_negative"
  );
  const mutationAttempt = realTestSource.indexOf(
    "physicalPhases.markExact0004DatabaseMutationAttempted();"
  );
  assert.ok(conflictingStart);
  assert.ok(conflictingComplete);
  assert.equal(conflictingStart.index < mutationAttempt, true);
  assert.equal(mutationAttempt < conflictingComplete.index, true);
  const rollbackStart = realTestSource.indexOf(
    'physicalPhases.startExact0004Subphase("rollback_verification")',
    conflictingComplete.index
  );
  assert.notEqual(rollbackStart, -1);
  const conflictingRoute = realTestSource.slice(
    conflictingStart.index,
    rollbackStart
  );
  const conflictingRouteTokens = [
    "physicalPhases.markExact0004DatabaseMutationAttempted();",
    "const conflictId = await insertExact0004Conflict(",
    "physicalPhases.markExact0004ConflictingNegativeAttempted();",
    "physicalPhases.observeExact0004ConflictingNegative(",
    "runnerA.applyExact(",
    "await assert.rejects(",
    'const matched = error?.code === "23514";',
    "physicalPhases.markExact0004ConflictingNegativeAssertionMatched(",
    "return matched;",
    'physicalPhases.completeExact0004Subphase(\n      "conflicting_0004_negative"'
  ];
  for (const token of conflictingRouteTokens) {
    assert.equal(
      conflictingRoute.split(token).length - 1,
      1,
      token
    );
  }
  const conflictingRoutePositions = conflictingRouteTokens.map(
    (token) => conflictingRoute.indexOf(token)
  );
  assert.deepEqual(
    [...conflictingRoutePositions].sort((left, right) => left - right),
    conflictingRoutePositions
  );
  assert.equal(
    conflictingRoute.includes('error?.code === "P0001"'),
    false
  );
  assert.equal(
    /error\?\.(?:message|stack|detail|hint|where)|\b(?:query|parameters)\b/.test(
      conflictingRoute
    ),
    false
  );

  function activeConflictingNegativeEmitter() {
    const lines = [];
    const physicalPhases = createPhysicalPhaseEmitter(
      (line) => lines.push(line)
    );
    for (const phase of PHYSICAL_MAIN_PHASES) {
      physicalPhases.startMain(phase);
      if (phase !== "exact_0004_plan_apply") {
        physicalPhases.completeMain(phase);
        continue;
      }
      for (const subphase of executionSubphases) {
        physicalPhases.startExact0004Subphase(subphase);
        if (subphase === "conflicting_0004_negative") {
          physicalPhases.markExact0004DatabaseMutationAttempted();
          physicalPhases.markExact0004ConflictingNegativeAttempted();
          return { lines, physicalPhases };
        }
        physicalPhases.completeExact0004Subphase(subphase);
      }
    }
    throw new Error("synthetic_conflicting_negative_subphase_missing");
  }

  function parsedSafeEvents(lines) {
    return lines.map((line) => {
      assert.equal(line.startsWith(SAFE_EVENT_PREFIX), true);
      return JSON.parse(line.slice(SAFE_EVENT_PREFIX.length));
    });
  }

  async function observeConflict({ outcome, value }) {
    const { lines, physicalPhases } = activeConflictingNegativeEmitter();
    let applyExactCalls = 0;
    let fulfillmentIdentityPreserved = null;
    let predicateCalls = 0;
    let rejectionIdentityPreserved = null;
    let assertionFailure = null;
    const applyExactOnce = () => {
      applyExactCalls += 1;
      return outcome === "fulfilled"
        ? Promise.resolve(value)
        : Promise.reject(value);
    };
    const observedPromise =
      physicalPhases.observeExact0004ConflictingNegative(applyExactOnce());
    try {
      await assert.rejects(
        observedPromise,
        (error) => {
          predicateCalls += 1;
          rejectionIdentityPreserved = error === value;
          const matched = error?.code === "23514";
          physicalPhases.markExact0004ConflictingNegativeAssertionMatched(
            matched
          );
          return matched;
        }
      );
    } catch (error) {
      assertionFailure = error;
    }
    if (outcome === "fulfilled") {
      fulfillmentIdentityPreserved = await observedPromise === value;
    }
    assert.equal(applyExactCalls, 1);
    const events = parsedSafeEvents(lines);
    const attemptedIndex = events.findIndex(
      ({ event }) => event === "exact0004ConflictingNegativeAttempted"
    );
    const settledIndex = events.findIndex(
      ({ event }) => event === "exact0004ConflictingNegativePromiseSettled"
    );
    const assertionIndex = events.findIndex(
      ({ event }) => event === "exact0004ConflictingNegativeAssertionMatched"
    );
    assert.notEqual(attemptedIndex, -1);
    assert.equal(attemptedIndex < settledIndex, true);
    assert.equal(
      outcome === "rejected"
        ? settledIndex < assertionIndex
        : assertionIndex === -1,
      true
    );
    const attempted = events[attemptedIndex];
    const settled = events[settledIndex];
    const assertion = assertionIndex === -1 ? null : events[assertionIndex];
    const evidence = {
      conflictingNegativeAttempted:
        attempted.conflictingNegativeAttempted,
      conflictingNegativePromiseOutcome:
        settled.conflictingNegativePromiseOutcome,
      conflictingNegativeObservedSqlState:
        settled.conflictingNegativeObservedSqlState,
      conflictingNegativeFulfilledResultClass:
        settled.conflictingNegativeFulfilledResultClass,
      conflictingNegativeAssertionMatched:
        assertion?.conflictingNegativeAssertionMatched ?? null,
      conflictingNegativeRejectedBeforeAssertion:
        settled.conflictingNegativeRejectedBeforeAssertion
    };
    assert.deepEqual(Object.keys(evidence), conflictingNegativeEvidenceFields);
    assert.equal(conflictingNegativeEvidenceValid(evidence), true);
    return {
      applyExactCalls,
      assertionFailure,
      evidence,
      fulfillmentIdentityPreserved,
      lines,
      predicateCalls,
      rejectionIdentityPreserved
    };
  }

  const correctError = Object.assign(
    new Error("raw_correct_message_must_not_escape"),
    {
      code: "23514",
      detail: "raw_correct_detail_must_not_escape",
      hint: "raw_correct_hint_must_not_escape"
    }
  );
  const correctRejection = await observeConflict({
    outcome: "rejected",
    value: correctError
  });
  assert.equal(correctRejection.assertionFailure, null);
  assert.equal(correctRejection.predicateCalls, 1);
  assert.equal(correctRejection.rejectionIdentityPreserved, true);
  assert.deepEqual(correctRejection.evidence, {
    conflictingNegativeAttempted: true,
    conflictingNegativePromiseOutcome: "rejected",
    conflictingNegativeObservedSqlState: "23514",
    conflictingNegativeFulfilledResultClass: "not_observed",
    conflictingNegativeAssertionMatched: true,
    conflictingNegativeRejectedBeforeAssertion: true
  });

  const differentSqlState = await observeConflict({
    outcome: "rejected",
    value: Object.assign(new Error("raw_other_state_must_not_escape"), {
      code: "P0001"
    })
  });
  assert.equal(differentSqlState.assertionFailure?.code, "ERR_ASSERTION");
  assert.equal(differentSqlState.predicateCalls, 1);
  assert.equal(differentSqlState.rejectionIdentityPreserved, true);
  assert.deepEqual(differentSqlState.evidence, rejectedDifferentSqlState);

  const fulfilledNothing = await observeConflict({
    outcome: "fulfilled",
    value: undefined
  });
  assert.equal(fulfilledNothing.assertionFailure?.code, "ERR_ASSERTION");
  assert.equal(fulfilledNothing.predicateCalls, 0);
  assert.equal(fulfilledNothing.rejectionIdentityPreserved, null);
  assert.equal(fulfilledNothing.fulfillmentIdentityPreserved, true);
  assert.deepEqual(fulfilledNothing.evidence, fulfilledEmpty);

  const rawTokenKey = ["to", "ken"].join("");
  const rawTokenValue = ["raw", "token", "must", "not", "escape"].join("_");
  const appliedResult = {
    appliedMigration: "0004_social_connector_persistence",
    parameters: ["raw_parameter_must_not_escape"],
    query: "SELECT raw_sql_must_not_escape",
    [rawTokenKey]: rawTokenValue
  };
  const fulfilledApplied = await observeConflict({
    outcome: "fulfilled",
    value: appliedResult
  });
  assert.equal(fulfilledApplied.assertionFailure?.code, "ERR_ASSERTION");
  assert.equal(fulfilledApplied.predicateCalls, 0);
  assert.equal(fulfilledApplied.fulfillmentIdentityPreserved, true);
  assert.deepEqual(fulfilledApplied.evidence, fulfilledApplied0004);

  const missingCodeError = new Error("raw_missing_code_must_not_escape");
  missingCodeError.stack =
    "raw_stack_must_not_escape C:\\private\\outcome.js:9:1";
  const missingCode = await observeConflict({
    outcome: "rejected",
    value: missingCodeError
  });
  assert.equal(missingCode.assertionFailure?.code, "ERR_ASSERTION");
  assert.deepEqual(missingCode.evidence, rejectedWithoutCode);

  const invalidCode = await observeConflict({
    outcome: "rejected",
    value: Object.assign(new Error("raw_invalid_code_must_not_escape"), {
      code: "invalid_sqlstate"
    })
  });
  assert.equal(invalidCode.assertionFailure?.code, "ERR_ASSERTION");
  assert.deepEqual(invalidCode.evidence, rejectedWithoutCode);

  const fulfilledArray = await observeConflict({
    outcome: "fulfilled",
    value: []
  });
  assert.equal(
    fulfilledArray.evidence.conflictingNegativeFulfilledResultClass,
    "other"
  );
  const throwingResult = {};
  Object.defineProperty(throwingResult, "appliedMigration", {
    get() {
      throw new Error("raw_getter_failure_must_not_escape");
    }
  });
  const fulfilledUnknown = await observeConflict({
    outcome: "fulfilled",
    value: throwingResult
  });
  assert.equal(
    fulfilledUnknown.evidence.conflictingNegativeFulfilledResultClass,
    "unknown"
  );

  const serializedEvidence = [
    correctRejection,
    differentSqlState,
    fulfilledNothing,
    fulfilledApplied,
    missingCode,
    invalidCode,
    fulfilledArray,
    fulfilledUnknown
  ].flatMap(({ lines }) => lines).join("");
  for (const forbidden of [
    "raw_correct_message_must_not_escape",
    "raw_correct_detail_must_not_escape",
    "raw_correct_hint_must_not_escape",
    "raw_other_state_must_not_escape",
    "raw_parameter_must_not_escape",
    "raw_sql_must_not_escape",
    rawTokenValue,
    "raw_missing_code_must_not_escape",
    "raw_stack_must_not_escape",
    "C:\\private",
    "raw_invalid_code_must_not_escape",
    "invalid_sqlstate",
    "raw_getter_failure_must_not_escape"
  ]) assert.equal(serializedEvidence.includes(forbidden), false, forbidden);
  assert.equal(
    realTestSource.split(
      "async function proveMigratorExplicitRoleBoundary(pool, physicalPhases) {"
    ).length - 1,
    1
  );
  assert.equal(
    realTestSource.split(
      "await proveMigratorExplicitRoleBoundary(migrationPoolA, physicalPhases);"
    ).length - 1,
    1
  );
});
