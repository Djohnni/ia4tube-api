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
  "social/checkpoint-3b0-exact-0004-runner-linux-permission-boundary-20260814";
const BASE = "13e38b875db2a220514fe06113663c517c975592";
const SOURCE_COMMIT = "8534817574a22dbd144a835c9f3585c44ee11c96";
const MESSAGE =
  "[run-social-3b0] pinpoint exact 0004 permission boundary";
const IMAGE =
  "docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const RUNNER_FILE = "scripts/run-real-postgres-tests.js";
const RUNNER_MODULE = "./scripts/run-real-postgres-tests";
const RUNNER_LF_SHA256 =
  "efac7d0ce2c0bcd4b1fc83c692b610749de0e842badbb71e4d66e9f384e5673d";
const RUNNER_FILTERED_OID = "dec34f1bc10ee2d1f06737bb07f6bca4ec5770f5";
const PRESERVED_FUNCTIONAL_FILES = Object.freeze([
  "scripts/social-db-migrate.js",
  "src/persistence/postgres/migrations.js",
  "tests/social-postgres-migrations.test.js"
]);
const REAL_TEST_FILE = "tests/social-postgres-real.test.js";
const REAL_TEST_LF_SHA256 =
  "0435be028c5e3d1aa04e2094ae60f92e17528434ec63f5c31516db803fb190c7";
const REAL_TEST_FILTERED_OID = "caa0cf840214a1ce6572c8f338a92dd4d8146e87";
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
const EXACT14 = Object.freeze([
  ".github/workflows/social-3b0-exact-0004-runner-linux.yml",
  "scripts/run-node-tests.js",
  RUNNER_FILE,
  "scripts/social-3a0p-local-scope.js",
  "scripts/social-db-migrate.js",
  "src/persistence/postgres/migrations.js",
  "tests/node-test-runner-safety.test.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-linux-workflow.test.js",
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
const EVIDENCE_KEYS = Object.freeze([
  ...LEGACY_EVIDENCE_KEYS,
  ...SAFE_EVIDENCE_KEYS
]);
const RUNNER_FACT_KEYS = Object.freeze([
  ...SAFE_EVIDENCE_KEYS.filter((key) => key !== "evidenceSchemaVersion"),
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
  const startToken = "expected=(\n";
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
  return Function(
    "mainPhases",
    "phaseSet",
    "permissionOrigins",
    "safeSources",
    "lineBuckets",
    `"use strict";${inlineFunction(source, signature)};return validBoundary;`
  )(
    physicalPhases.slice(0, -1),
    new Set(physicalPhases),
    new Set(permissionOrigins),
    new Set(inlineClosedSet(source, "safeSources")),
    new Set(inlineClosedSet(source, "lineBuckets"))
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
    timeout: 20_000,
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

test("Exact-0004 Linux workflow fixes branch, parent, message, first push and Exact14", () => {
  const { source, workflow } = read();
  assert.deepEqual(workflow.env, {
    SOCIAL_EXACT_BASE: BASE,
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
  const guard = stepByName(currentJob, "Verify immutable Exact14 contract").run;
  assert.ok(guard.includes("git rev-parse HEAD^"));
  assert.ok(guard.includes("git rev-list --parents -n 1 HEAD"));
  assert.ok(guard.includes("git diff-tree --no-commit-id --name-only -r --no-renames -z"));
  assert.ok(guard.includes("${#actual[@]}") && guard.includes("${#expected[@]}"));
  assert.equal(EXACT14.length, 14);
  assert.equal(new Set(EXACT14).size, 14);
  const guardInventory = bashExpectedInventory(guard);
  assert.deepEqual(guardInventory, EXACT14);
  const physical = stepByName(
    currentJob,
    "Run the one-shot PostgreSQL 18 Exact-0004 proof"
  );
  const finalize = stepByName(currentJob, "Finalize sanitized four-file evidence");
  const enforcement = stepByName(currentJob, "Enforce final Exact-0004 result");
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
    assert.deepEqual(inventory, EXACT14, name);
    assert.equal(
      inventory.filter((file) => file === RUNNER_FILE).length,
      1,
      name
    );
  }
  const { pins: runnerPins } = runnerPinMap(guard);
  assert.deepEqual(runnerPins, { [RUNNER_FILE]: RUNNER_LF_SHA256 });
  const { pins: physicalPins } = physicalTestPinMap(guard);
  assert.deepEqual(physicalPins, { [REAL_TEST_FILE]: REAL_TEST_LF_SHA256 });
  assert.equal(
    source.split(`'${RUNNER_FILE}'`).length - 1,
    5,
    "five semantic runner path positions"
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
    "social/checkpoint-3b0-exact-0004-runner-linux-safe-evidence-20260814",
    "[run-social-3b0] preserve safe evidence before exact 0004 TAP",
    "eb92d862c70a78a907e82628cd6a5768ecc8f113570dd13ba5d3ca8cc15f8f98",
    HISTORICAL_REAL_TEST_LF_SHA256
  ]) assert.equal(source.includes(stale), false, stale);
  assert.equal((guard.match(/functional=\(/g) || []).length, 1);
  assert.equal((guard.match(/instrumented=\(/g) || []).length, 1);
  assert.ok(guard.includes("100644") && guard.includes("blob"));
});

test("functional and instrumented pins come from canonical Git blobs", () => {
  const { workflow } = read();
  const guard = stepByName(
    job(workflow),
    "Verify immutable Exact14 contract"
  ).run;
  const pins = functionalPins(guard);
  const { pins: physicalPins } = physicalTestPinMap(guard);
  assert.deepEqual(Object.keys(pins), FUNCTIONAL_FILES);
  assert.deepEqual(physicalPins, { [REAL_TEST_FILE]: REAL_TEST_LF_SHA256 });
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
  if (process.platform === "win32") assert.equal(materializationDiffers, true);
  for (const formerPin of FORMER_WINDOWS_WORKTREE_PINS) {
    assert.equal(Object.values(pins).includes(formerPin), false, formerPin);
    assert.equal(Object.values(physicalPins).includes(formerPin), false, formerPin);
  }
});

test("instrumented runner pin is the canonical filtered LF blob", () => {
  const { workflow } = read();
  const guard = stepByName(
    job(workflow),
    "Verify immutable Exact14 contract"
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
  const runnerSource = canonical.toString("utf8");
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
    "verifyFinalProfile"
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
    safeLineBucket: "unknown"
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
        safeLineBucket: "1-499"
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
        safeLineBucket: "1-499"
      }),
      expected: true
    }),
    Object.freeze({
      label: "permission_without_origin_proof_is_unknown",
      value: Object.freeze({
        ...boundaryBase,
        failurePhase: "physical_target_preflight",
        safeErrorCode: null,
        safePermissionOrigin: "unknown"
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
        safePermissionOrigin: "unknown"
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

test("evidence keeps legacy schema 1 and uses the closed safe schema 3", () => {
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
  assert.equal(EVIDENCE_KEYS.length, 46);
  assert.equal(new Set(EVIDENCE_KEYS).size, 46);
  assert.equal(RUNNER_FACT_KEYS.length, 23);
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
      new RegExp(`${valueName}\\.evidenceSchemaVersion\\s*!==\\s*3`)
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
      "environment",
      "url",
      "password"
    ]) assert.equal(evidenceTuple.values.includes(forbidden), false, forbidden);
    for (const boundaryFragment of [
      "physical_target_preflight",
      "reauthentication",
      "final_cleanup",
      "postgres_sqlstate",
      "os_filesystem",
      "os_process",
      "4000-4499",
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
    "safeLineBucket"
  ]) assert.ok(physical.run.includes(`${nullable}:null`), nullable);
  for (const booleanDefault of [
    "cleanupStarted",
    "cleanupCompleted",
    "failureDuringCleanup"
  ]) assert.ok(physical.run.includes(`${booleanDefault}:false`), booleanDefault);
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
  assert.ok(
    finalize.run.includes("evidenceSchemaVersion:3") &&
    finalize.run.includes("safeLineBucket:'unknown'")
  );
  for (const key of EVIDENCE_KEYS) assert.ok(source.includes(key), key);
  for (const key of PROCESS_STATUS_KEYS) assert.ok(source.includes(key), key);
  assert.equal(source.includes("process.env.DATABASE_URL"), false);
  assert.equal(source.includes("process.env.SOCIAL_MIGRATIONS_DATABASE_URL"), false);
  assert.equal(source.includes("process.env.PGPASSWORD"), false);
  assert.equal(source.includes("process.env.INSTAGRAM_APP_SECRET"), false);
});
