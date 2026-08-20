"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { TextDecoder } = require("node:util");
const {
  assertHarnessOnlyChangedFiles
} = require("../scripts/social-3a0p-local-scope");

const ROUTE_BRANCH =
  "social/checkpoint-3b0-exact-0004-runner-linux-conflict-sqlstate-20260820";
const ROUTE_BASE_COMMIT = "13e38b875db2a220514fe06113663c517c975592";
const ROUTE_PARENT_COMMIT = "53bae8b3457b515b0e656d5b37fce4dc04d5e89f";
const FUNCTIONAL_COMMIT = ROUTE_PARENT_COMMIT;
const POST_COMMIT_PROOF_HEAD = "ffffffffffffffffffffffffffffffffffffffff";
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const AUTHORIZED_CHANGED_FILES = Object.freeze([
  ".github/workflows/social-3b0-exact-0004-runner-linux.yml",
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
const INCREMENTAL_CHANGED_FILES = Object.freeze([
  ".github/workflows/social-3b0-exact-0004-runner-linux.yml",
  "scripts/social-3a0p-local-scope.js",
  "tests/node-test-runner-safety.test.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-exact-0004-runner-linux-workflow.test.js",
  "tests/social-postgres-real.test.js"
]);
const LOCAL_UNTRACKED_FILES = Object.freeze([]);
const LOCAL_UNSTAGED_TRACKED_FILES = Object.freeze([
  ...INCREMENTAL_CHANGED_FILES
]);
const AUTHORIZED_PRODUCT_FILES = Object.freeze([]);
const PROTECTED_PRODUCT_DIRECTORIES = Object.freeze([
  "src",
  "db",
  "migrations"
]);
const PROTECTED_PRODUCT_FILES = new Set([
  "roles.sql",
  "server.js",
  "package.json",
  "package-lock.json"
]);
const NETWORK_GIT_COMMANDS = new Set([
  "clone",
  "fetch",
  "ls-remote",
  "pull",
  "push",
  "submodule"
]);
const INDEX_WRITING_GIT_COMMANDS = new Set([
  "add",
  "apply",
  "checkout",
  "commit",
  "merge",
  "mv",
  "read-tree",
  "reset",
  "restore",
  "rm",
  "update-index",
  "write-tree"
]);
const ROOT = path.resolve(__dirname, "..");
const GIT_ENV = Object.freeze({
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never"
});

class ScopeInventoryFailure extends Error {
  constructor(code, operation, cause) {
    super(operation ? code + " (" + operation + ")" : code);
    this.code = code;
    this.name = "ScopeInventoryFailure";
    if (operation) {
      this.operation = operation;
    }
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function refuse(code, operation, cause) {
  throw new ScopeInventoryFailure(code, operation, cause);
}

function refuseGit(operation, reason, cause) {
  refuse("scope_git_" + operation + "_" + reason, operation, cause);
}

function runGitRead(operation, args, spawnImpl = spawnSync) {
  let result;
  try {
    result = spawnImpl("git", args, {
      cwd: ROOT,
      encoding: null,
      env: GIT_ENV,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true
    });
  } catch (cause) {
    refuseGit(
      operation,
      cause && cause.code === "ETIMEDOUT" ? "timeout" : "spawn_error",
      cause
    );
  }
  if (!result || typeof result !== "object") {
    refuseGit(operation, "result_invalid");
  }
  if (result.error !== undefined) {
    refuseGit(
      operation,
      result.error && result.error.code === "ETIMEDOUT"
        ? "timeout"
        : "spawn_error",
      result.error
    );
  }
  if (result.signal !== null) {
    refuseGit(operation, "signal");
  }
  if (result.status !== 0) {
    refuseGit(operation, "status");
  }
  if (!Buffer.isBuffer(result.stdout)) {
    refuseGit(operation, "output_invalid");
  }
  return result.stdout;
}

function decodeUtf8Fatal(buffer, operation) {
  if (!Buffer.isBuffer(buffer)) {
    refuseGit(operation, "output_invalid");
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(buffer);
  } catch (cause) {
    refuseGit(operation, "utf8_invalid", cause);
  }
}

function parseHead(buffer) {
  const operation = "head";
  const output = decodeUtf8Fatal(buffer, operation);
  const match = /^([0-9a-f]{40})\r?\n$/.exec(output);
  if (!match) {
    refuseGit(operation, "output_invalid");
  }
  return match[1];
}

function normalizeRepositoryPath(file, operation) {
  if (typeof file !== "string" || !file || file.includes("\0")) {
    refuseGit(operation, "path_invalid");
  }
  const normalized = file.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (
    path.posix.isAbsolute(normalized) ||
    /^[a-z]:/i.test(normalized) ||
    components.some(
      (component) =>
        component === "" || component === "." || component === ".."
    )
  ) {
    refuseGit(operation, "path_invalid");
  }
  return normalized;
}

function parseNulPaths(buffer, operation) {
  const output = decodeUtf8Fatal(buffer, operation);
  if (output.length === 0) {
    return Object.freeze([]);
  }
  if (!output.endsWith("\0")) {
    refuseGit(operation, "nul_invalid");
  }
  const rawPaths = output.split("\0");
  rawPaths.pop();
  if (rawPaths.some((file) => file === "")) {
    refuseGit(operation, "nul_invalid");
  }
  const seen = new Set();
  const normalizedPaths = [];
  for (const rawPath of rawPaths) {
    const normalized = normalizeRepositoryPath(rawPath, operation);
    if (seen.has(normalized)) {
      refuseGit(operation, "path_duplicate");
    }
    seen.add(normalized);
    normalizedPaths.push(normalized);
  }
  normalizedPaths.sort();
  return Object.freeze(normalizedPaths);
}

function createPathCommandSpecifications(head) {
  return Object.freeze([
    Object.freeze({
      field: "routeCommittedFiles",
      operation: "route_committed",
      args: Object.freeze([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "--no-renames",
        "-z",
        ROUTE_BASE_COMMIT,
        head,
        "--"
      ])
    }),
    Object.freeze({
      field: "functionalCommittedFiles",
      operation: "functional_committed",
      args: Object.freeze([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "--no-renames",
        "-z",
        FUNCTIONAL_COMMIT,
        head,
        "--"
      ])
    }),
    Object.freeze({
      field: "stagedFiles",
      operation: "staged",
      args: Object.freeze([
        "diff-index",
        "--cached",
        "--name-only",
        "--no-renames",
        "-z",
        head,
        "--"
      ])
    }),
    Object.freeze({
      field: "unstagedTrackedFiles",
      operation: "unstaged_tracked",
      args: Object.freeze([
        "diff-files",
        "--name-only",
        "--no-renames",
        "-z",
        "--"
      ])
    }),
    Object.freeze({
      field: "untrackedFiles",
      operation: "untracked",
      args: Object.freeze([
        "ls-files",
        "--others",
        "--exclude-standard",
        "--full-name",
        "-z",
        "--"
      ])
    })
  ]);
}

function buildGitSnapshot(spawnImpl = spawnSync) {
  const head = parseHead(
    runGitRead("head", ["rev-parse", "--verify", "HEAD"], spawnImpl)
  );
  const pathLists = {};
  for (const specification of createPathCommandSpecifications(head)) {
    pathLists[specification.field] = parseNulPaths(
      runGitRead(
        specification.operation,
        [...specification.args],
        spawnImpl
      ),
      specification.operation
    );
  }
  return Object.freeze({
    head,
    routeCommittedFiles: pathLists.routeCommittedFiles,
    functionalCommittedFiles: pathLists.functionalCommittedFiles,
    stagedFiles: pathLists.stagedFiles,
    unstagedTrackedFiles: pathLists.unstagedTrackedFiles,
    untrackedFiles: pathLists.untrackedFiles
  });
}

function createSnapshotCache(builder) {
  let attempted = false;
  let attemptCount = 0;
  let value;
  let failure;
  let failed = false;
  return Object.freeze({
    read() {
      if (!attempted) {
        attempted = true;
        attemptCount += 1;
        try {
          value = builder();
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
      if (failed) {
        throw failure;
      }
      return value;
    },
    get attemptCount() {
      return attemptCount;
    }
  });
}

function validateSnapshotPathList(files, field) {
  if (!Array.isArray(files)) {
    refuse("scope_snapshot_list_invalid", field);
  }
  const operation = "snapshot_" + field;
  const seen = new Set();
  const normalizedFiles = [];
  for (const file of files) {
    const normalized = normalizeRepositoryPath(file, operation);
    if (seen.has(normalized)) {
      refuse("scope_snapshot_path_duplicate", field);
    }
    seen.add(normalized);
    normalizedFiles.push(normalized);
  }
  normalizedFiles.sort();
  return Object.freeze(normalizedFiles);
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    refuse("scope_snapshot_invalid");
  }
  if (
    typeof snapshot.head !== "string" ||
    !/^[0-9a-f]{40}$/.test(snapshot.head)
  ) {
    refuse("scope_snapshot_head_invalid");
  }
  return Object.freeze({
    head: snapshot.head,
    routeCommittedFiles: validateSnapshotPathList(
      snapshot.routeCommittedFiles,
      "routeCommittedFiles"
    ),
    functionalCommittedFiles: validateSnapshotPathList(
      snapshot.functionalCommittedFiles,
      "functionalCommittedFiles"
    ),
    stagedFiles: validateSnapshotPathList(
      snapshot.stagedFiles,
      "stagedFiles"
    ),
    unstagedTrackedFiles: validateSnapshotPathList(
      snapshot.unstagedTrackedFiles,
      "unstagedTrackedFiles"
    ),
    untrackedFiles: validateSnapshotPathList(
      snapshot.untrackedFiles,
      "untrackedFiles"
    )
  });
}

function unionPaths(...pathLists) {
  const union = new Set();
  for (const pathList of pathLists) {
    for (const file of pathList) {
      union.add(file);
    }
  }
  return Object.freeze([...union].sort());
}

function assertExactFiles(actual, expected, code) {
  const expectedSorted = [...expected].sort();
  if (
    actual.length !== expectedSorted.length ||
    actual.some((file, index) => file !== expectedSorted[index])
  ) {
    refuse(code);
  }
}

function assertRouteInventory(snapshotInput) {
  const snapshot = validateSnapshot(snapshotInput);
  const localMode = snapshot.head === ROUTE_PARENT_COMMIT;
  if (localMode) {
    assertExactFiles(
      snapshot.routeCommittedFiles,
      AUTHORIZED_CHANGED_FILES,
      "scope_route_committed_refused"
    );
    assertExactFiles(snapshot.stagedFiles, [], "scope_staged_refused");
    assertExactFiles(
      snapshot.functionalCommittedFiles,
      [],
      "scope_incremental_committed_refused"
    );
    assertExactFiles(
      snapshot.untrackedFiles,
      LOCAL_UNTRACKED_FILES,
      "scope_untracked_refused"
    );
    assertExactFiles(
      snapshot.unstagedTrackedFiles,
      LOCAL_UNSTAGED_TRACKED_FILES,
      "scope_unstaged_refused"
    );
  } else {
    assertExactFiles(
      snapshot.routeCommittedFiles,
      AUTHORIZED_CHANGED_FILES,
      "scope_route_committed_refused"
    );
    assertExactFiles(snapshot.stagedFiles, [], "scope_staged_refused");
    assertExactFiles(
      snapshot.functionalCommittedFiles,
      INCREMENTAL_CHANGED_FILES,
      "scope_incremental_committed_refused"
    );
    assertExactFiles(
      snapshot.unstagedTrackedFiles,
      [],
      "scope_unstaged_refused"
    );
    assertExactFiles(snapshot.untrackedFiles, [], "scope_untracked_refused");
  }
  const files = unionPaths(
    snapshot.routeCommittedFiles,
    snapshot.stagedFiles,
    snapshot.unstagedTrackedFiles,
    snapshot.untrackedFiles
  );
  assertExactFiles(files, AUTHORIZED_CHANGED_FILES, "scope_union_refused");
  const harnessScope = assertHarnessOnlyChangedFiles([...files]);
  if (
    harnessScope.harnessOnly !== true ||
    harnessScope.changedFileCount !== AUTHORIZED_CHANGED_FILES.length
  ) {
    refuse("scope_harness_contract_refused");
  }
  return Object.freeze({
    files,
    mode: localMode ? "local" : "post_commit"
  });
}

function isProtectedProductPath(file) {
  const normalized = normalizeRepositoryPath(file, "product_filter");
  return (
    PROTECTED_PRODUCT_FILES.has(normalized) ||
    PROTECTED_PRODUCT_DIRECTORIES.some(
      (directory) =>
        normalized === directory ||
        normalized.startsWith(directory + "/")
    )
  );
}

function assertNoProtectedProductChanges(snapshotInput) {
  const snapshot = validateSnapshot(snapshotInput);
  const productFiles = unionPaths(
    snapshot.functionalCommittedFiles,
    snapshot.stagedFiles,
    snapshot.unstagedTrackedFiles,
    snapshot.untrackedFiles
  ).filter(isProtectedProductPath);
  assertExactFiles(
    productFiles,
    AUTHORIZED_PRODUCT_FILES,
    "scope_product_change_refused"
  );
  return Object.freeze(productFiles);
}

function makeLocalSnapshot(overrides = {}) {
  return {
    head: ROUTE_PARENT_COMMIT,
    routeCommittedFiles: [...AUTHORIZED_CHANGED_FILES],
    functionalCommittedFiles: [],
    stagedFiles: [],
    unstagedTrackedFiles: [...LOCAL_UNSTAGED_TRACKED_FILES],
    untrackedFiles: [...LOCAL_UNTRACKED_FILES],
    ...overrides
  };
}

function makePostCommitSnapshot(overrides = {}) {
  return {
    head: POST_COMMIT_PROOF_HEAD,
    routeCommittedFiles: [...AUTHORIZED_CHANGED_FILES],
    functionalCommittedFiles: [...INCREMENTAL_CHANGED_FILES],
    stagedFiles: [],
    unstagedTrackedFiles: [],
    untrackedFiles: [],
    ...overrides
  };
}

function encodeNulPaths(files) {
  if (files.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.from(files.join("\0") + "\0", "utf8");
}

function successfulSpawnResult(stdout) {
  return {
    error: undefined,
    signal: null,
    status: 0,
    stderr: Buffer.alloc(0),
    stdout: Buffer.from(stdout)
  };
}

function createCapturedSuccessfulSpawn() {
  const calls = [];
  const outputs = [
    Buffer.from(ROUTE_PARENT_COMMIT + "\n", "utf8"),
    encodeNulPaths(AUTHORIZED_CHANGED_FILES),
    Buffer.alloc(0),
    Buffer.alloc(0),
    encodeNulPaths(LOCAL_UNSTAGED_TRACKED_FILES),
    encodeNulPaths(LOCAL_UNTRACKED_FILES)
  ];
  return Object.freeze({
    calls,
    spawnImpl(command, args, options) {
      const callIndex = calls.length;
      calls.push(Object.freeze({
        command,
        args: Object.freeze([...args]),
        options
      }));
      if (callIndex >= outputs.length) {
        throw new Error("unexpected_git_call");
      }
      return successfulSpawnResult(outputs[callIndex]);
    }
  });
}

function runMandatoryContractProofs() {
  let proofCount = 0;
  let capturedCalls = [];
  function proof(callback) {
    callback();
    proofCount += 1;
  }

  // 1. Local mode recognizes exactly the eighteen authorized paths.
  proof(() => {
    const result = assertRouteInventory(makeLocalSnapshot());
    assert.equal(result.mode, "local");
    assert.deepEqual(result.files, [...AUTHORIZED_CHANGED_FILES].sort());
  });

  // 2. Post-commit mode recognizes exactly the same eighteen paths.
  proof(() => {
    const result = assertRouteInventory(makePostCommitSnapshot());
    assert.equal(result.mode, "post_commit");
    assert.deepEqual(result.files, [...AUTHORIZED_CHANGED_FILES].sort());
  });

  // 3. Unexpected staged content is refused.
  proof(() => {
    assert.throws(
      () => assertRouteInventory(makeLocalSnapshot({
        stagedFiles: [AUTHORIZED_CHANGED_FILES[0]]
      })),
      { code: "scope_staged_refused" }
    );
  });

  // 4. Unexpected untracked content is refused.
  proof(() => {
    assert.throws(
      () => assertRouteInventory(makeLocalSnapshot({
        untrackedFiles: ["tests/untracked-scope-proof.test.js"]
      })),
      { code: "scope_untracked_refused" }
    );
  });

  // 5. Incomplete Incremental7 inventories and any eighth path are refused.
  proof(() => {
    for (const unstagedTrackedFiles of [
      LOCAL_UNSTAGED_TRACKED_FILES.slice(0, 5),
      LOCAL_UNSTAGED_TRACKED_FILES.slice(0, 6),
      [
        ...LOCAL_UNSTAGED_TRACKED_FILES,
        "tests/eighth-incremental-path.test.js"
      ]
    ]) {
      assert.throws(
        () => assertRouteInventory(makeLocalSnapshot({
          unstagedTrackedFiles
        })),
        { code: "scope_unstaged_refused" }
      );
    }
  });

  // 6. Product paths are refused from every required snapshot source.
  proof(() => {
    assert.deepEqual(
      assertNoProtectedProductChanges(makeLocalSnapshot()),
      [...AUTHORIZED_PRODUCT_FILES].sort()
    );
    for (const field of [
      "functionalCommittedFiles",
      "stagedFiles",
      "unstagedTrackedFiles",
      "untrackedFiles"
    ]) {
      assert.throws(
        () => assertNoProtectedProductChanges(makeLocalSnapshot({
          [field]: ["src/social/vault.js"]
        })),
        { code: "scope_product_change_refused" }
      );
    }
    for (const file of [
      "src",
      "src/social/vault.js",
      "db",
      "db/postgres/roles.sql",
      "migrations",
      "migrations/0001.sql",
      "roles.sql",
      "server.js",
      "package.json",
      "package-lock.json"
    ]) {
      assert.equal(isProtectedProductPath(file), true, file);
    }
    for (const file of [
      "src_backup/file.js",
      "database/file.sql",
      "server.js.bak",
      "package.json.tmp"
    ]) {
      assert.equal(isProtectedProductPath(file), false, file);
    }
  });

  // 7. Rename detection stays disabled and both physical paths are refused.
  proof(() => {
    for (const specification of createPathCommandSpecifications(
      ROUTE_BASE_COMMIT
    )) {
      if (specification.args[0].startsWith("diff")) {
        assert.equal(specification.args.includes("--no-renames"), true);
      }
    }
    assert.throws(
      () => assertRouteInventory(makeLocalSnapshot({
        unstagedTrackedFiles: [
          ...AUTHORIZED_CHANGED_FILES,
          "tests/renamed-current-diff-scope.test.js"
        ]
      })),
      { code: "scope_unstaged_refused" }
    );
  });

  // 8. Duplicates after separator normalization are refused.
  proof(() => {
    assert.throws(
      () => parseNulPaths(
        encodeNulPaths(["tests\\same.test.js", "tests/same.test.js"]),
        "proof_duplicate"
      ),
      { code: "scope_git_proof_duplicate_path_duplicate" }
    );
  });

  // 9. A subprocess error is refused.
  proof(() => {
    const spawnError = Object.assign(new Error("spawn failed"), {
      code: "ENOENT"
    });
    assert.throws(
      () => runGitRead("proof_error", ["rev-parse"], () => ({
        error: spawnError,
        signal: null,
        status: null,
        stdout: Buffer.alloc(0)
      })),
      {
        code: "scope_git_proof_error_spawn_error",
        operation: "proof_error"
      }
    );
  });

  // 10. A subprocess signal is refused.
  proof(() => {
    assert.throws(
      () => runGitRead("proof_signal", ["rev-parse"], () => ({
        error: undefined,
        signal: "SIGTERM",
        status: null,
        stdout: Buffer.alloc(0)
      })),
      {
        code: "scope_git_proof_signal_signal",
        operation: "proof_signal"
      }
    );
  });

  // 11. A subprocess timeout is refused without retry.
  proof(() => {
    const timeoutError = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT"
    });
    assert.throws(
      () => runGitRead("proof_timeout", ["rev-parse"], () => ({
        error: timeoutError,
        signal: "SIGTERM",
        status: null,
        stdout: Buffer.alloc(0)
      })),
      {
        code: "scope_git_proof_timeout_timeout",
        operation: "proof_timeout"
      }
    );
  });

  // 12. A non-zero subprocess status is refused.
  proof(() => {
    assert.throws(
      () => runGitRead("proof_status", ["rev-parse"], () => ({
        error: undefined,
        signal: null,
        status: 7,
        stdout: Buffer.alloc(0)
      })),
      {
        code: "scope_git_proof_status_status",
        operation: "proof_status"
      }
    );
  });

  // 13. Invalid NUL, UTF-8, absolute and traversal output is refused.
  proof(() => {
    assert.throws(
      () => parseNulPaths(
        Buffer.from("tests/missing-nul.test.js", "utf8"),
        "proof_nul"
      ),
      { code: "scope_git_proof_nul_nul_invalid" }
    );
    assert.throws(
      () => parseNulPaths(
        Buffer.from("tests/a.test.js\0\0", "utf8"),
        "proof_nul"
      ),
      { code: "scope_git_proof_nul_nul_invalid" }
    );
    assert.throws(
      () => parseNulPaths(
        encodeNulPaths(["C:\\repo\\absolute.test.js"]),
        "proof_absolute"
      ),
      { code: "scope_git_proof_absolute_path_invalid" }
    );
    assert.throws(
      () => parseNulPaths(
        encodeNulPaths(["tests/../traversal.test.js"]),
        "proof_traversal"
      ),
      { code: "scope_git_proof_traversal_path_invalid" }
    );
    assert.throws(
      () => parseNulPaths(
        Buffer.from([0xc3, 0x28, 0x00]),
        "proof_utf8"
      ),
      { code: "scope_git_proof_utf8_utf8_invalid" }
    );
    assert.deepEqual(
      parseNulPaths(
        encodeNulPaths(["tests/z.test.js", "Tests/Name With Space.test.js"]),
        "proof_preserve"
      ),
      ["Tests/Name With Space.test.js", "tests/z.test.js"]
    );
  });

  // 14. Snapshot success and failure are each calculated at most once.
  proof(() => {
    const snapshotValue = Object.freeze({ head: ROUTE_PARENT_COMMIT });
    let successCalls = 0;
    const successCache = createSnapshotCache(() => {
      successCalls += 1;
      return snapshotValue;
    });
    assert.strictEqual(successCache.read(), snapshotValue);
    assert.strictEqual(successCache.read(), snapshotValue);
    assert.equal(successCalls, 1);
    assert.equal(successCache.attemptCount, 1);

    const sentinel = new Error("cached_snapshot_failure");
    let failureCalls = 0;
    const failureCache = createSnapshotCache(() => {
      failureCalls += 1;
      throw sentinel;
    });
    assert.throws(() => failureCache.read(), (error) => error === sentinel);
    assert.throws(() => failureCache.read(), (error) => error === sentinel);
    assert.equal(failureCalls, 1);
    assert.equal(failureCache.attemptCount, 1);
  });

  // 15. The closed snapshot uses only the six local non-network reads.
  proof(() => {
    const capture = createCapturedSuccessfulSpawn();
    const snapshot = buildGitSnapshot(capture.spawnImpl);
    capturedCalls = capture.calls;
    assert.deepEqual(
      assertRouteInventory(snapshot).files,
      [...AUTHORIZED_CHANGED_FILES].sort()
    );
    assert.deepEqual(
      capturedCalls.map((call) => call.args),
      [
        ["rev-parse", "--verify", "HEAD"],
        ...createPathCommandSpecifications(ROUTE_PARENT_COMMIT)
          .map((specification) => [...specification.args])
      ]
    );
    assert.equal(capturedCalls.length, 6);
    for (const call of capturedCalls) {
      assert.equal(call.command, "git");
      assert.equal(NETWORK_GIT_COMMANDS.has(call.args[0]), false);
    }
  });

  // 16. No command writes or refreshes the index.
  proof(() => {
    assert.equal(capturedCalls.length, 6);
    for (const call of capturedCalls) {
      assert.equal(INDEX_WRITING_GIT_COMMANDS.has(call.args[0]), false);
      assert.equal(call.args.includes("--refresh"), false);
      assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, "0");
    }
    const stagedRead = capturedCalls.find(
      (call) => call.args[0] === "diff-index"
    );
    assert.ok(stagedRead);
    assert.equal(stagedRead.args.includes("--cached"), true);
  });

  // 17. The 20-second timeout and all closed spawn options stay exact.
  proof(() => {
    assert.equal(capturedCalls.length, 6);
    for (const call of capturedCalls) {
      assert.equal(call.options.cwd, ROOT);
      assert.equal(call.options.encoding, null);
      assert.equal(call.options.maxBuffer, GIT_MAX_BUFFER_BYTES);
      assert.equal(call.options.shell, false);
      assert.equal(call.options.timeout, GIT_TIMEOUT_MS);
      assert.equal(call.options.timeout, 20_000);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(call.options.env.GCM_INTERACTIVE, "Never");
    }
  });

  assert.equal(proofCount, 17);
  return proofCount;
}

const sharedSnapshotCache = createSnapshotCache(() => buildGitSnapshot());

test("a barreira do runner exato 0004 contem exatamente os dezoito caminhos autorizados", () => {
  const result = assertRouteInventory(sharedSnapshotCache.read());
  assert.equal(
    ROUTE_BRANCH,
    "social/checkpoint-3b0-exact-0004-runner-linux-conflict-sqlstate-20260820"
  );
  assert.equal(
    ROUTE_PARENT_COMMIT,
    "53bae8b3457b515b0e656d5b37fce4dc04d5e89f"
  );
  assert.equal(
    ROUTE_BASE_COMMIT,
    "13e38b875db2a220514fe06113663c517c975592"
  );
  assert.equal(AUTHORIZED_CHANGED_FILES.length, 18);
  assert.equal(new Set(AUTHORIZED_CHANGED_FILES).size, 18);
  assert.equal(INCREMENTAL_CHANGED_FILES.length, 7);
  assert.equal(new Set(INCREMENTAL_CHANGED_FILES).size, 7);
  assert.deepEqual(LOCAL_UNSTAGED_TRACKED_FILES, INCREMENTAL_CHANGED_FILES);
  assert.deepEqual(LOCAL_UNTRACKED_FILES, []);
  assert.deepEqual(result.files, [...AUTHORIZED_CHANGED_FILES].sort());
  assert.equal(
    result.mode === "local" || result.mode === "post_commit",
    true
  );
  assert.equal(sharedSnapshotCache.attemptCount, 1);
  assert.equal(runMandatoryContractProofs(), 17);
});

test("nenhum arquivo de produto difere do pai imediato da rota", () => {
  const productFiles = assertNoProtectedProductChanges(
    sharedSnapshotCache.read()
  );
  assert.deepEqual(productFiles, [...AUTHORIZED_PRODUCT_FILES].sort());
  assert.equal(sharedSnapshotCache.attemptCount, 1);
});
