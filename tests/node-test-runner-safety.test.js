"use strict";

const assert = require("node:assert/strict");
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
const EXPECTED_SERIAL_FILES = Object.freeze([
  ...PREVIOUS_SERIAL_FILES,
  ...ADDED_WINDOWS_NATIVE_SERIAL_FILES
]);
const SYNTHETIC_TEST_DIRECTORY = path.resolve("synthetic-runner-tests");
const SYNTHETIC_REPOSITORY_ROOT = path.resolve("synthetic-runner-root");
const SYNTHETIC_EXECUTABLE = path.resolve("synthetic-node");

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

test("3. the closed serial manifest contains the six previous and five native Windows files", () => {
  const repositoryTests = discoverAutomatedTests(path.resolve(__dirname)).map((file) =>
    path.basename(file)
  );
  const previousSet = new Set(PREVIOUS_SERIAL_FILES);
  assert.deepEqual(PROCESS_LIFECYCLE_TEST_FILES, EXPECTED_SERIAL_FILES);
  assert.equal(PROCESS_LIFECYCLE_TEST_FILES.length, 11);
  assert.deepEqual(
    PROCESS_LIFECYCLE_TEST_FILES.filter((name) => previousSet.has(name)),
    PREVIOUS_SERIAL_FILES
  );
  for (const name of ADDED_WINDOWS_NATIVE_SERIAL_FILES) {
    assert.equal(
      PROCESS_LIFECYCLE_TEST_FILES.filter((candidate) => candidate === name).length,
      1,
      name
    );
  }
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
