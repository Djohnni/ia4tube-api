"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RUNNER_PATH = path.resolve(
  __dirname,
  "../scripts/social-3a0p-linux-pre-gate-tests.js"
);
const {
  LINUX_PRE_GATE_TEST_FILES,
  main,
  validateLinuxPreGateManifest
} = require(RUNNER_PATH);

const EXPECTED_MANIFEST = Object.freeze([
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3a0p-linux-pre-gate-tests.test.js",
  "tests/social-3a0p-linux-workflow.test.js",
  "tests/social-3a0p-linux-durability.test.js",
  "tests/social-3a0p-linux-postgres.test.js",
  "tests/social-3a0p-local-connector-physical-gates.test.js",
  "tests/social-3a0p-linux-physical-gates.test.js",
  "tests/social-3a0p-linux-gate.test.js"
]);
const SYNTHETIC_REPOSITORY_ROOT = path.resolve("synthetic-linux-pre-gate-root");
const SYNTHETIC_EXECUTABLE = path.resolve("synthetic-node");

function relativeRepositoryFile(file) {
  return path.relative(SYNTHETIC_REPOSITORY_ROOT, file).replaceAll("\\", "/");
}

function fakeFilesystem({ missing = [], directories = [], symlinks = [] } = {}) {
  const inspected = [];
  const missingSet = new Set(missing);
  const directorySet = new Set(directories);
  const symlinkSet = new Set(symlinks);
  return {
    inspected,
    lstatSync(file) {
      const relative = relativeRepositoryFile(file);
      inspected.push(relative);
      if (missingSet.has(relative)) {
        throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
      }
      return {
        isFile() {
          return !directorySet.has(relative) && !symlinkSet.has(relative);
        },
        isSymbolicLink() {
          return symlinkSet.has(relative);
        }
      };
    }
  };
}

function invokeRunner({
  environment = Object.freeze({ SYNTHETIC_LINUX_PRE_GATE: "present" }),
  fsImpl = fakeFilesystem(),
  manifest = EXPECTED_MANIFEST,
  results = [],
  spawnSyncImpl
} = {}) {
  const calls = [];
  const stderr = [];
  let resultIndex = 0;
  const spawn = spawnSyncImpl || ((executable, args, options) => {
    calls.push({ executable, args, options });
    const result = results[resultIndex];
    resultIndex += 1;
    return result === undefined ? { status: 0, signal: null } : result;
  });
  const status = main({
    env: environment,
    execPath: SYNTHETIC_EXECUTABLE,
    fsImpl,
    manifest,
    repositoryRoot: SYNTHETIC_REPOSITORY_ROOT,
    spawnSyncImpl(executable, args, options) {
      if (spawnSyncImpl) calls.push({ executable, args, options });
      return spawn(executable, args, options);
    },
    stderr: {
      write(message) {
        stderr.push(String(message));
      }
    }
  });
  return { calls, environment, fsImpl, status, stderr };
}

function validationOptions(fsImpl = fakeFilesystem()) {
  return { fsImpl, repositoryRoot: SYNTHETIC_REPOSITORY_ROOT };
}

test("1. Linux pre-gate manifest is an exact frozen literal", () => {
  const source = fs.readFileSync(RUNNER_PATH, "utf8");
  assert.equal(Object.isFrozen(LINUX_PRE_GATE_TEST_FILES), true);
  assert.deepEqual(LINUX_PRE_GATE_TEST_FILES, EXPECTED_MANIFEST);
  assert.match(
    source,
    /const LINUX_PRE_GATE_TEST_FILES = Object\.freeze\(\[/
  );
  assert.doesNotMatch(source, /readdirSync|globSync|fast-glob/);
});

test("2. Linux pre-gate order is deterministic and is never silently sorted", () => {
  const first = invokeRunner();
  const second = invokeRunner();
  assert.deepEqual(
    first.calls.map((call) => call.args[1]),
    EXPECTED_MANIFEST
  );
  assert.deepEqual(
    second.calls.map((call) => call.args[1]),
    EXPECTED_MANIFEST
  );

  const reordered = [...EXPECTED_MANIFEST];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(
    () => validateLinuxPreGateManifest(reordered, validationOptions()),
    { code: "linux_pre_gate_manifest_order_invalid" }
  );
});

test("3. a duplicated manifest entry is refused before process creation", () => {
  const manifest = [...EXPECTED_MANIFEST, EXPECTED_MANIFEST[0]];
  assert.throws(
    () => validateLinuxPreGateManifest(manifest, validationOptions()),
    { code: "linux_pre_gate_manifest_duplicate" }
  );
  const execution = invokeRunner({ manifest });
  assert.equal(execution.status, 1);
  assert.equal(execution.calls.length, 0);
});

test("4. every absent, non-file or symbolic-link manifest target is refused", async (t) => {
  const target = EXPECTED_MANIFEST[3];
  const cases = [
    ["absent", fakeFilesystem({ missing: [target] })],
    ["directory", fakeFilesystem({ directories: [target] })],
    ["symlink", fakeFilesystem({ symlinks: [target] })]
  ];
  for (const [name, fsImpl] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validateLinuxPreGateManifest(EXPECTED_MANIFEST, validationOptions(fsImpl)),
        { code: "linux_pre_gate_manifest_file_missing" }
      );
    });
  }

  assert.throws(
    () => validateLinuxPreGateManifest(
      EXPECTED_MANIFEST.slice(0, -1),
      validationOptions()
    ),
    { code: "linux_pre_gate_manifest_file_missing" }
  );
});

test("5. every extra or substituted manifest file is refused", () => {
  for (const manifest of [
    [...EXPECTED_MANIFEST, "tests/unexpected.test.js"],
    ["tests/unexpected.test.js", ...EXPECTED_MANIFEST.slice(1)]
  ]) {
    assert.throws(
      () => validateLinuxPreGateManifest(manifest, validationOptions()),
      { code: "linux_pre_gate_manifest_file_extra" }
    );
  }
});

test("6. POSIX absolute paths are refused", () => {
  const manifest = ["/repo/tests/unexpected.test.js", ...EXPECTED_MANIFEST.slice(1)];
  assert.throws(
    () => validateLinuxPreGateManifest(manifest, validationOptions()),
    { code: "linux_pre_gate_manifest_path_invalid" }
  );
});

test("7. Windows absolute and backslash paths are refused", () => {
  for (const file of [
    "C:/repo/tests/unexpected.test.js",
    "C:\\repo\\tests\\unexpected.test.js",
    "\\\\server\\share\\unexpected.test.js"
  ]) {
    const manifest = [file, ...EXPECTED_MANIFEST.slice(1)];
    assert.throws(
      () => validateLinuxPreGateManifest(manifest, validationOptions()),
      { code: "linux_pre_gate_manifest_path_invalid" }
    );
  }
});

test("8. traversal and non-canonical relative paths are refused", () => {
  for (const file of [
    "../tests/unexpected.test.js",
    "tests/../tests/unexpected.test.js",
    "./tests/unexpected.test.js",
    "tests//unexpected.test.js",
    "tests/./unexpected.test.js"
  ]) {
    const manifest = [file, ...EXPECTED_MANIFEST.slice(1)];
    assert.throws(
      () => validateLinuxPreGateManifest(manifest, validationOptions()),
      { code: "linux_pre_gate_manifest_path_invalid" }
    );
  }
});

test("9. no file appears twice in the canonical manifest", () => {
  assert.equal(LINUX_PRE_GATE_TEST_FILES.length, 8);
  assert.equal(new Set(LINUX_PRE_GATE_TEST_FILES).size, 8);
});

test("10. every manifest file is executed exactly once with Node test", () => {
  const execution = invokeRunner();
  assert.equal(execution.status, 0);
  assert.equal(execution.calls.length, EXPECTED_MANIFEST.length);
  assert.deepEqual(
    execution.calls.map((call) => call.args),
    EXPECTED_MANIFEST.map((file) => ["--test", file])
  );
});

test("11. failure of the first file prevents every following file", () => {
  const execution = invokeRunner({ results: [{ status: 7, signal: null }] });
  assert.equal(execution.status, 7);
  assert.equal(execution.calls.length, 1);
  assert.deepEqual(execution.calls[0].args, ["--test", EXPECTED_MANIFEST[0]]);
});

test("12. a child failure status is preserved unchanged", () => {
  const execution = invokeRunner({
    results: [
      { status: 0, signal: null },
      { status: 0, signal: null },
      { status: 23, signal: null }
    ]
  });
  assert.equal(execution.status, 23);
  assert.equal(execution.calls.length, 3);
});

test("13. thrown and returned spawn errors fail closed without raw diagnostics", async (t) => {
  await t.test("thrown", () => {
    const execution = invokeRunner({
      spawnSyncImpl() {
        throw new Error("synthetic-secret-spawn-error");
      }
    });
    assert.equal(execution.status, 1);
    assert.equal(execution.calls.length, 1);
    assert.equal(execution.stderr.join("").includes("synthetic-secret"), false);
  });
  await t.test("returned", () => {
    const execution = invokeRunner({
      results: [{
        error: new Error("synthetic-secret-result-error"),
        signal: null,
        status: null
      }]
    });
    assert.equal(execution.status, 1);
    assert.equal(execution.calls.length, 1);
    assert.equal(execution.stderr.join("").includes("synthetic-secret"), false);
  });
});

test("14. a null child status or signal fails closed", () => {
  const execution = invokeRunner({
    results: [{ status: null, signal: "SIGTERM" }]
  });
  assert.equal(execution.status, 1);
  assert.equal(execution.calls.length, 1);
});

test("15. every child keeps the exact repository cwd", () => {
  const { calls } = invokeRunner();
  for (const call of calls) {
    assert.equal(call.options.cwd, SYNTHETIC_REPOSITORY_ROOT);
  }
});

test("16. every child inherits the exact environment reference", () => {
  const execution = invokeRunner();
  for (const call of execution.calls) {
    assert.strictEqual(call.options.env, execution.environment);
  }
});

test("17. every child keeps stdio inherited", () => {
  const { calls } = invokeRunner();
  for (const call of calls) assert.equal(call.options.stdio, "inherit");
});

test("18. the runner never enables a shell", () => {
  const { calls } = invokeRunner();
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.options, "shell"), false);
  }
});

test("19. a failed file is never retried", () => {
  const execution = invokeRunner({
    results: [
      { status: 0, signal: null },
      { status: 0, signal: null },
      { status: 4, signal: null },
      { status: 0, signal: null }
    ]
  });
  assert.equal(execution.status, 4);
  assert.equal(execution.calls.length, 3);
  assert.equal(
    execution.calls.filter((call) => call.args[1] === EXPECTED_MANIFEST[2]).length,
    1
  );
});

test("20. a successful execution makes one pass with no repetition loop", () => {
  const execution = invokeRunner({
    results: Array(EXPECTED_MANIFEST.length * 2).fill({ status: 0, signal: null })
  });
  const counts = new Map();
  for (const call of execution.calls) {
    counts.set(call.args[1], (counts.get(call.args[1]) || 0) + 1);
  }
  assert.equal(execution.calls.length, EXPECTED_MANIFEST.length);
  for (const file of EXPECTED_MANIFEST) assert.equal(counts.get(file), 1, file);
});

test("21. the runner adds no timeout", () => {
  const { calls } = invokeRunner();
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.options, "timeout"), false);
  }
});

test("22. a Windows-local test file is refused before process creation", () => {
  const manifest = [
    "tests/social-3a0p-local-windows-adapters.test.js",
    ...EXPECTED_MANIFEST.slice(1)
  ];
  assert.throws(
    () => validateLinuxPreGateManifest(manifest, validationOptions()),
    { code: "linux_pre_gate_manifest_file_extra" }
  );
  const execution = invokeRunner({ manifest });
  assert.equal(execution.status, 1);
  assert.equal(execution.calls.length, 0);
});

test("23. the runner does not inspect or serialize secret environment values", () => {
  let secretAccesses = 0;
  const environment = new Proxy({}, {
    get() {
      secretAccesses += 1;
      throw new Error("secret value was read");
    },
    getOwnPropertyDescriptor() {
      secretAccesses += 1;
      throw new Error("secret descriptor was read");
    },
    ownKeys() {
      secretAccesses += 1;
      throw new Error("secret environment was enumerated");
    }
  });
  const execution = invokeRunner({ environment });
  assert.equal(execution.status, 0);
  assert.equal(secretAccesses, 0);
  for (const call of execution.calls) assert.strictEqual(call.options.env, environment);
});

test("24. the runner performs no filesystem write and creates no artifact", () => {
  const accessedMethods = [];
  const base = fakeFilesystem();
  const fsImpl = new Proxy(base, {
    get(target, property, receiver) {
      accessedMethods.push(String(property));
      if (property !== "lstatSync") {
        throw new Error(`unexpected filesystem operation: ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const execution = invokeRunner({ fsImpl });
  assert.equal(execution.status, 0);
  assert.deepEqual(
    [...new Set(accessedMethods)],
    ["lstatSync"]
  );
});

test("25. the runner invokes tests only and never executes the physical gate", () => {
  const source = fs.readFileSync(RUNNER_PATH, "utf8");
  const execution = invokeRunner();
  for (const call of execution.calls) {
    assert.equal(call.executable, SYNTHETIC_EXECUTABLE);
    assert.deepEqual(call.args, ["--test", call.args[1]]);
    assert.equal(call.args[1].startsWith("tests/"), true);
    assert.equal(call.args.includes("--run"), false);
  }
  assert.doesNotMatch(
    source,
    /require\(["']\.\/social-3a0p-linux-(?:gate|physical-gates)["']\)/
  );
  assert.doesNotMatch(source, /["']--run["']/);
});
