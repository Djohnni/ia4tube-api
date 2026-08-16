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
  "27a4d1ebbccda40711fd1a78a2f170efa3128690b86588be0c7ab515345f49d0";
const REAL_POSTGRES_TEST_FILTERED_OID =
  "bebdc618879cabd589dbe93a3b6a2c9a172aa98e";
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
    "(client) => client.query(ledgerRead)",
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
    "async function proveMigratorExplicitRoleBoundary(pool) {",
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
  assert.equal(roleBoundaryHelper, authorizedRoleBoundaryHelper);

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
    "  await proveMigratorExplicitRoleBoundary(migrationPoolA);"
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
      current: authorizedRoleBoundaryHelper,
      previous: ""
    },
    {
      label: "negative invocation before the first snapshot",
      current: "  await proveMigratorExplicitRoleBoundary(migrationPoolA);\n",
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
  let permissionBoundaryCandidate = realTestSource;
  for (const { current, previous, label } of authorizedPermissionReplacements) {
    permissionBoundaryCandidate = replaceExactlyOnce(
      permissionBoundaryCandidate,
      current,
      previous,
      label
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
    Buffer.from(permissionBoundaryCandidate, "utf8"),
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
    34
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
    "      physicalPhases.startCleanup();\n",
    "      physicalPhases.completeCleanup();\n"
  ];
  let baselineCandidate = sourceWithoutBinding;
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
    "async function proveMigratorExplicitRoleBoundary(pool) {",
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
    (roleBoundaryHelper.match(/\(client\) => client\.query\(ledgerRead\)/g) || [])
      .length,
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
    "async function proveMigratorExplicitRoleBoundary(pool) {",
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
