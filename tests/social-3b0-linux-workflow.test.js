"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const WORKFLOW_RELATIVE_PATH =
  ".github/workflows/social-3b0-instagram-oauth-local-contract.yml";
const HISTORICAL_WORKFLOW_RELATIVE_PATH =
  ".github/workflows/social-3a0p-linux-physical-gates.yml";
const PHYSICAL_GATE_RELATIVE_PATH =
  "scripts/social-3b0-linux-physical-gate.js";
const WORKFLOW_PATH = path.join(
  REPOSITORY_ROOT,
  ...WORKFLOW_RELATIVE_PATH.split("/")
);
const HISTORICAL_WORKFLOW_PATH = path.join(
  REPOSITORY_ROOT,
  ...HISTORICAL_WORKFLOW_RELATIVE_PATH.split("/")
);
const PHYSICAL_GATE_PATH = path.join(
  REPOSITORY_ROOT,
  ...PHYSICAL_GATE_RELATIVE_PATH.split("/")
);
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW_PATH, "utf8");
const WORKFLOW = JSON.parse(WORKFLOW_TEXT);
const PHYSICAL_GATE_TEXT = fs.readFileSync(PHYSICAL_GATE_PATH, "utf8");
const HISTORICAL_WORKFLOW_SHA256 =
  "92ea893458ce8125bde7e316ea7fdc8b72015245f132175ecf2b4037f512fff6";
const HISTORICAL_WORKFLOW_BLOB = "7d66809ba2495aa6d2c4c8dc4d2f5ff03c991693";
const BRANCH =
  "social/checkpoint-3b0-o22-cleanup-provenance-20260812";
const ZERO_SHA = "0000000000000000000000000000000000000000";
const O12_CORRECTION_COMMIT = "1febe1211b0021d8c35cdfb840f581fd76ce39e7";
const O05_CORRECTION_COMMIT = "ad3c162aaee04bb66d79ea3c35c3d75297e8d0ab";
const PREVIOUS_CORRECTION_COMMIT = "27cd350a253ab3ff07a915570eb41f291bbd1b42";
const PRIOR_INFRA_COMMIT = "7bff67ac0c1acdd37473889a3f8b5c2017b30c9c";
const FUNCTIONAL_COMMIT = "33e3ea7abcea7f5dc51780c3a1efd4743352fe40";
const FUNCTIONAL_PARENT = "3dc3d8be62438216509f061f6c1a26ee39c9b5dc";
const CORRECTION_MESSAGE =
  "[run-social-3b0] capture first-attempt O22 cleanup provenance";
const O12_CORRECTION_MESSAGE =
  "[run-social-3b0] verify pending credential without operational activation";
const O05_CORRECTION_MESSAGE =
  "[run-social-3b0] preserve loopback JSON payload until request flush";
const PREVIOUS_CORRECTION_MESSAGE =
  "[run-social-3b0] align Gate 3 replay and remote evidence contracts";
const PRIOR_INFRA_MESSAGE =
  "[run-social-3b0] validate Instagram OAuth contract remotely";
const FUNCTIONAL_MESSAGE =
  "[social-3b0] implement local Instagram OAuth authorize callback exchange";
const FUNCTIONAL_PARENT_MESSAGE =
  "[run-social-3a0p-linux-gate] refuse cross-profile restore before transport";
const IMAGE =
  "docker.io/library/postgres:18.4-bookworm@sha256:" +
  "7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const ACTIONS = Object.freeze({
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact:
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
});
const JOB_IF = [
  "github.event_name == 'push'",
  `github.ref == 'refs/heads/${BRANCH}'`,
  "github.event.created == true",
  "github.event.deleted == false",
  "github.event.forced == false",
  `github.event.before == '${ZERO_SHA}'`,
  `github.event.head_commit.message == '${CORRECTION_MESSAGE}'`,
  "github.run_attempt == 1"
].join(" && ");
const FUNCTIONAL_FILES = Object.freeze([
  "scripts/social-3a0p-local-scope.js",
  "server.js",
  "src/persistence/postgres/social-oauth-repository.js",
  "src/social/auth-adapter.js",
  "src/social/credential-service.js",
  "src/social/oauth/instagram-config.js",
  "src/social/oauth/instagram-oauth-router.js",
  "src/social/oauth/instagram-oauth-service.js",
  "src/social/oauth/instagram-provider.js",
  "src/social/oauth/instagram-state-envelope.js",
  "src/social/runtime.js",
  "src/social/server-runtime.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-instagram-oauth-crypto-provider.test.js",
  "tests/social-3b0-instagram-oauth-routes.test.js",
  "tests/social-connector-persistence.test.js",
  "tests/social-server-runtime.test.js"
]);
const PRIOR_INFRASTRUCTURE_FILES = Object.freeze([
  ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
  "docs/social-3b0-instagram-oauth-local-contract.md",
  "scripts/social-3b0-linux-physical-gate.js",
  "tests/social-3a0p-linux-workflow.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-3b0-linux-workflow.test.js",
  "scripts/social-3a0p-local-scope.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3a0p-current-diff-scope.test.js"
]);
const PREVIOUS_CORRECTION_FILES = Object.freeze([
  ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
  "docs/social-3b0-instagram-oauth-local-contract.md",
  "scripts/social-3a0p-linux-physical-gates.js",
  "scripts/social-3a0p-local-scope.js",
  "scripts/social-3b0-linux-physical-gate.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-linux-physical-gates.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-3b0-linux-workflow.test.js"
]);
const O05_CORRECTION_FILES = Object.freeze([
  ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
  "docs/social-3b0-instagram-oauth-local-contract.md",
  "scripts/social-3a0p-local-scope.js",
  "scripts/social-3b0-linux-physical-gate.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3a0p-local-scope.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-3b0-linux-workflow.test.js"
]);
const O12_CORRECTION_FILES = Object.freeze([
  ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
  "docs/social-3b0-instagram-oauth-local-contract.md",
  "scripts/social-3b0-linux-physical-gate.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-3b0-linux-workflow.test.js"
]);
const CURRENT_CORRECTION_FILES = Object.freeze([
  ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
  "docs/social-3b0-instagram-oauth-local-contract.md",
  "scripts/social-3b0-linux-physical-gate.js",
  "tests/social-3a0p-current-diff-scope.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-3b0-linux-workflow.test.js"
]);
const PRE_GATE_TEST_FILES = Object.freeze([
  "tests/social-3b0-instagram-oauth-crypto-provider.test.js",
  "tests/social-3b0-instagram-oauth-routes.test.js",
  "tests/social-3b0-linux-workflow.test.js",
  "tests/social-3b0-linux-physical-gate.test.js",
  "tests/social-3a0p-current-diff-scope.test.js"
]);
const ARTIFACT_NAME =
  "social-3b0-instagram-oauth-local-contract-evidence";
const ARTIFACT_FILES = Object.freeze([
  "social-3b0-instagram-oauth-local-contract-evidence.json",
  "social-3b0-instagram-oauth-local-contract-evidence.sha256",
  "social-3b0-instagram-oauth-local-contract-process-status.json",
  "social-3b0-instagram-oauth-local-contract-process-status.sha256"
]);

function step(job, name) {
  const candidate = job.steps.find((entry) => entry.name === name);
  assert.ok(candidate, `missing workflow step: ${name}`);
  return candidate;
}

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function sourceSection(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source boundary: ${start}`);
  assert.ok(to > from, `missing source boundary: ${end}`);
  return source.slice(from, to);
}

function extractSingleQuotedLines(source, start, end) {
  return sourceSection(source, start, end)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^'([^']+)'[,]?$/.exec(line);
      assert.ok(match, `noncanonical quoted inventory line: ${line}`);
      return match[1];
    });
}

function collectUses(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectUses(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if (key === "uses") output.push(item);
    collectUses(item, output);
  }
  return output;
}

function collectKeys(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    output.push(key);
    collectKeys(item, output);
  }
  return output;
}

test("historical Social 3A-0P workflow remains byte-identical", () => {
  const raw = fs.readFileSync(HISTORICAL_WORKFLOW_PATH, "utf8");
  assert.equal(/\r(?!\n)/.test(raw), false);
  const digest = crypto
    .createHash("sha256")
    .update(raw.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
  assert.equal(digest, HISTORICAL_WORKFLOW_SHA256);
});

test("workflow is strict JSON with one branch-creation push trigger", () => {
  assert.deepEqual(Object.keys(WORKFLOW), [
    "name",
    "on",
    "permissions",
    "concurrency",
    "env",
    "jobs"
  ]);
  assert.deepEqual(WORKFLOW.on, {
    push: { branches: [BRANCH] }
  });
  assert.deepEqual(WORKFLOW.permissions, { contents: "read" });
  assert.deepEqual(WORKFLOW.concurrency, {
    group: "social-3b0-instagram-oauth-local-contract-${{ github.ref }}",
    "cancel-in-progress": false
  });
  assert.deepEqual(Object.keys(WORKFLOW.jobs), [
    "windows-automated-tests",
    "linux-physical-validation"
  ]);

  const forbiddenKeys = new Set([
    "pull_request",
    "workflow_dispatch",
    "schedule",
    "strategy",
    "matrix",
    "services",
    "container",
    "ports"
  ]);
  assert.deepEqual(
    collectKeys(WORKFLOW).filter((key) => forbiddenKeys.has(key)),
    []
  );
});

test("all Actions are full-SHA pinned and artifact upload occurs once", () => {
  const uses = collectUses(WORKFLOW);
  assert.deepEqual(uses, [
    ACTIONS.checkout,
    ACTIONS.setupNode,
    ACTIONS.checkout,
    ACTIONS.setupNode,
    ACTIONS.uploadArtifact
  ]);
  for (const value of uses) {
    assert.match(value, /^[a-z0-9_-]+\/[a-z0-9_-]+@[0-9a-f]{40}$/i);
  }
  assert.equal(uses.filter((value) => value === ACTIONS.uploadArtifact).length, 1);
});

test("both jobs enforce the first immutable push and the exact six-commit correction chain", () => {
  const windows = WORKFLOW.jobs["windows-automated-tests"];
  const linux = WORKFLOW.jobs["linux-physical-validation"];
  assert.equal(FUNCTIONAL_FILES.length, 18);
  assert.equal(PRIOR_INFRASTRUCTURE_FILES.length, 9);
  assert.equal(PREVIOUS_CORRECTION_FILES.length, 10);
  assert.equal(O05_CORRECTION_FILES.length, 8);
  assert.equal(O12_CORRECTION_FILES.length, 6);
  assert.equal(CURRENT_CORRECTION_FILES.length, 6);
  assert.deepEqual(WORKFLOW.env, {
    SOCIAL_3B0_O12_CORRECTION_COMMIT: O12_CORRECTION_COMMIT,
    SOCIAL_3B0_O05_CORRECTION_COMMIT: O05_CORRECTION_COMMIT,
    SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT: PREVIOUS_CORRECTION_COMMIT,
    SOCIAL_3B0_PRIOR_INFRA_COMMIT: PRIOR_INFRA_COMMIT,
    SOCIAL_3B0_FUNCTIONAL_COMMIT: FUNCTIONAL_COMMIT,
    SOCIAL_3B0_FUNCTIONAL_PARENT: FUNCTIONAL_PARENT,
    SOCIAL_3B0_CORRECTION_MESSAGE: CORRECTION_MESSAGE,
    SOCIAL_3B0_O12_CORRECTION_MESSAGE: O12_CORRECTION_MESSAGE,
    SOCIAL_3B0_O05_CORRECTION_MESSAGE: O05_CORRECTION_MESSAGE,
    SOCIAL_3B0_PREVIOUS_CORRECTION_MESSAGE: PREVIOUS_CORRECTION_MESSAGE,
    SOCIAL_3B0_PRIOR_INFRA_MESSAGE: PRIOR_INFRA_MESSAGE,
    SOCIAL_3B0_FUNCTIONAL_MESSAGE: FUNCTIONAL_MESSAGE,
    SOCIAL_3B0_FUNCTIONAL_PARENT_MESSAGE: FUNCTIONAL_PARENT_MESSAGE
  });
  assert.equal(windows.if, JOB_IF);
  assert.equal(
    linux.if,
    `needs['windows-automated-tests'].result == 'success' && ${JOB_IF}`
  );
  assert.equal(linux.needs, "windows-automated-tests");

  const guards = [
    step(windows, "Verify the immutable six-commit correction contract").run,
    step(linux, "Verify the immutable six-commit correction contract").run
  ];
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[0],
      "$priorInfrastructureFiles = @(\n",
      ")\n$previousCorrectionFiles = @("
    ),
    PRIOR_INFRASTRUCTURE_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[1],
      "prior_infrastructure_files=(\n",
      ")\nprevious_correction_files=("
    ),
    PRIOR_INFRASTRUCTURE_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[0],
      "$previousCorrectionFiles = @(\n",
      ")\n$o05CorrectionFiles = @("
    ),
    PREVIOUS_CORRECTION_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[1],
      "previous_correction_files=(\n",
      ")\no05_correction_files=("
    ),
    PREVIOUS_CORRECTION_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[0],
      "$o05CorrectionFiles = @(\n",
      ")\n$o12CorrectionFiles = @("
    ),
    O05_CORRECTION_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[1],
      "o05_correction_files=(\n",
      ")\no12_correction_files=("
    ),
    O05_CORRECTION_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[0],
      "$o12CorrectionFiles = @(\n",
      ")\n$currentCorrectionFiles = @("
    ),
    O12_CORRECTION_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[1],
      "o12_correction_files=(\n",
      ")\ncurrent_correction_files=("
    ),
    O12_CORRECTION_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[0],
      "$currentCorrectionFiles = @(\n",
      ")\nAssert-Equal"
    ),
    CURRENT_CORRECTION_FILES
  );
  assert.deepEqual(
    extractSingleQuotedLines(
      guards[1],
      "current_correction_files=(\n",
      ")\ntest \"$AUTHORIZED_ATTEMPT\""
    ),
    CURRENT_CORRECTION_FILES
  );
  for (const guard of guards) {
    for (const value of [
      "SOCIAL_3B0_O12_CORRECTION_COMMIT",
      "SOCIAL_3B0_O05_CORRECTION_COMMIT",
      "SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT",
      "SOCIAL_3B0_PRIOR_INFRA_COMMIT",
      "SOCIAL_3B0_FUNCTIONAL_COMMIT",
      "SOCIAL_3B0_FUNCTIONAL_PARENT",
      "SOCIAL_3B0_CORRECTION_MESSAGE",
      "SOCIAL_3B0_O12_CORRECTION_MESSAGE",
      "SOCIAL_3B0_O05_CORRECTION_MESSAGE",
      "SOCIAL_3B0_PREVIOUS_CORRECTION_MESSAGE",
      "SOCIAL_3B0_PRIOR_INFRA_MESSAGE",
      "SOCIAL_3B0_FUNCTIONAL_MESSAGE",
      "SOCIAL_3B0_FUNCTIONAL_PARENT_MESSAGE",
      HISTORICAL_WORKFLOW_BLOB
    ]) {
      assert.ok(guard.includes(value));
    }
    for (const file of FUNCTIONAL_FILES) assert.ok(guard.includes(file));
    for (const file of PRIOR_INFRASTRUCTURE_FILES) assert.ok(guard.includes(file));
    for (const file of PREVIOUS_CORRECTION_FILES) assert.ok(guard.includes(file));
    for (const file of O05_CORRECTION_FILES) assert.ok(guard.includes(file));
    for (const file of O12_CORRECTION_FILES) assert.ok(guard.includes(file));
    for (const file of CURRENT_CORRECTION_FILES) assert.ok(guard.includes(file));
    for (const file of [
      HISTORICAL_WORKFLOW_RELATIVE_PATH,
      "db/migrations",
      "db/postgres/roles.sql",
      "package.json",
      "package-lock.json"
    ]) {
      assert.ok(guard.includes(file));
    }
    assert.match(guard, /rev-list[^\n]+--count/);
    assert.match(guard, /[Ss]ingle[Pp]arent|assert_single_parent/);
    assert.match(guard, /100644 blob/);
    assert.match(guard, /status[^\n]+porcelain=v1[^\n]+untracked-files=all/);
  }
  assert.match(
    guards[0],
    /rev-list', '--count',[^\n]+SOCIAL_3B0_FUNCTIONAL_PARENT[^\n]+HEAD[^\n]+\)\) '6'/
  );
  assert.match(
    guards[1],
    /rev-list --count [^\n]+SOCIAL_3B0_FUNCTIONAL_PARENT[^\n]+HEAD[^\n]+ = '6'/
  );
  for (const fragment of [
    "@('rev-parse', 'HEAD^')) $env:SOCIAL_3B0_O12_CORRECTION_COMMIT",
    "@('rev-parse', \"$($env:SOCIAL_3B0_O12_CORRECTION_COMMIT)^\")) $env:SOCIAL_3B0_O05_CORRECTION_COMMIT",
    "@('rev-parse', \"$($env:SOCIAL_3B0_O05_CORRECTION_COMMIT)^\")) $env:SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT",
    "@('rev-parse', \"$($env:SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT)^\")) $env:SOCIAL_3B0_PRIOR_INFRA_COMMIT",
    "@('rev-parse', \"$($env:SOCIAL_3B0_PRIOR_INFRA_COMMIT)^\")) $env:SOCIAL_3B0_FUNCTIONAL_COMMIT",
    "@('rev-parse', \"$($env:SOCIAL_3B0_FUNCTIONAL_COMMIT)^\")) $env:SOCIAL_3B0_FUNCTIONAL_PARENT",
    "@('log', '-1', '--pretty=%B')) $env:SOCIAL_3B0_CORRECTION_MESSAGE",
    "@('log', '-1', '--pretty=%B', $env:SOCIAL_3B0_O12_CORRECTION_COMMIT)) $env:SOCIAL_3B0_O12_CORRECTION_MESSAGE",
    "@('log', '-1', '--pretty=%B', $env:SOCIAL_3B0_O05_CORRECTION_COMMIT)) $env:SOCIAL_3B0_O05_CORRECTION_MESSAGE",
    "@('log', '-1', '--pretty=%B', $env:SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT)) $env:SOCIAL_3B0_PREVIOUS_CORRECTION_MESSAGE",
    "@('log', '-1', '--pretty=%B', $env:SOCIAL_3B0_PRIOR_INFRA_COMMIT)) $env:SOCIAL_3B0_PRIOR_INFRA_MESSAGE"
  ]) assert.ok(guards[0].includes(fragment), fragment);
  for (const fragment of [
    "git rev-parse HEAD^)\" = \"$SOCIAL_3B0_O12_CORRECTION_COMMIT",
    "git rev-parse \"$SOCIAL_3B0_O12_CORRECTION_COMMIT^\")\" = \"$SOCIAL_3B0_O05_CORRECTION_COMMIT",
    "git rev-parse \"$SOCIAL_3B0_O05_CORRECTION_COMMIT^\")\" = \"$SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT",
    "git rev-parse \"$SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT^\")\" = \"$SOCIAL_3B0_PRIOR_INFRA_COMMIT",
    "git rev-parse \"$SOCIAL_3B0_PRIOR_INFRA_COMMIT^\")\" = \"$SOCIAL_3B0_FUNCTIONAL_COMMIT",
    "git rev-parse \"$SOCIAL_3B0_FUNCTIONAL_COMMIT^\")\" = \"$SOCIAL_3B0_FUNCTIONAL_PARENT",
    "git log -1 --pretty=%B)\" = \"$SOCIAL_3B0_CORRECTION_MESSAGE",
    "git log -1 --pretty=%B \"$SOCIAL_3B0_O12_CORRECTION_COMMIT\")\" = \"$SOCIAL_3B0_O12_CORRECTION_MESSAGE",
    "git log -1 --pretty=%B \"$SOCIAL_3B0_O05_CORRECTION_COMMIT\")\" = \"$SOCIAL_3B0_O05_CORRECTION_MESSAGE",
    "git log -1 --pretty=%B \"$SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT\")\" = \"$SOCIAL_3B0_PREVIOUS_CORRECTION_MESSAGE",
    "git log -1 --pretty=%B \"$SOCIAL_3B0_PRIOR_INFRA_COMMIT\")\" = \"$SOCIAL_3B0_PRIOR_INFRA_MESSAGE"
  ]) assert.ok(guards[1].includes(fragment), fragment);
  for (const pattern of [
    /Assert-ExactFiles \$functionalChanged \$functionalFiles/,
    /Assert-ExactFiles \$priorInfrastructureChanged \$priorInfrastructureFiles/,
    /Assert-ExactFiles \$previousCorrectionChanged \$previousCorrectionFiles/,
    /Assert-ExactFiles \$o05CorrectionChanged \$o05CorrectionFiles/,
    /Assert-ExactFiles \$o12CorrectionChanged \$o12CorrectionFiles/,
    /Assert-ExactFiles \$currentCorrectionChanged \$currentCorrectionFiles/
  ]) assert.match(guards[0], pattern);
  for (const pattern of [
    /assert_exact_files "\$SOCIAL_3B0_FUNCTIONAL_COMMIT" "\$\{functional_files\[@\]\}"/,
    /assert_exact_files "\$SOCIAL_3B0_PRIOR_INFRA_COMMIT" "\$\{prior_infrastructure_files\[@\]\}"/,
    /assert_exact_files "\$SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT" "\$\{previous_correction_files\[@\]\}"/,
    /assert_exact_files "\$SOCIAL_3B0_O05_CORRECTION_COMMIT" "\$\{o05_correction_files\[@\]\}"/,
    /assert_exact_files "\$SOCIAL_3B0_O12_CORRECTION_COMMIT" "\$\{o12_correction_files\[@\]\}"/,
    /assert_exact_files HEAD "\$\{current_correction_files\[@\]\}"/
  ]) assert.match(guards[1], pattern);
  assert.match(
    guards[0],
    /Assert-RegularBlobs \$env:SOCIAL_3B0_FUNCTIONAL_COMMIT \$functionalFiles/
  );
  assert.match(
    guards[0],
    /Assert-RegularBlobs \$env:SOCIAL_3B0_PRIOR_INFRA_COMMIT \$priorInfrastructureFiles/
  );
  assert.match(
    guards[0],
    /Assert-RegularBlobs \$env:SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT \$previousCorrectionFiles/
  );
  assert.match(
    guards[0],
    /Assert-RegularBlobs \$env:SOCIAL_3B0_O05_CORRECTION_COMMIT \$o05CorrectionFiles/
  );
  assert.match(
    guards[0],
    /Assert-RegularBlobs \$env:SOCIAL_3B0_O12_CORRECTION_COMMIT \$o12CorrectionFiles/
  );
  assert.match(guards[0], /Assert-RegularBlobs 'HEAD' \$currentCorrectionFiles/);
  assert.match(
    guards[1],
    /assert_regular_blobs "\$SOCIAL_3B0_FUNCTIONAL_COMMIT" "\$\{functional_files\[@\]\}"/
  );
  assert.match(
    guards[1],
    /assert_regular_blobs "\$SOCIAL_3B0_PRIOR_INFRA_COMMIT" "\$\{prior_infrastructure_files\[@\]\}"/
  );
  assert.match(
    guards[1],
    /assert_regular_blobs "\$SOCIAL_3B0_PREVIOUS_CORRECTION_COMMIT" "\$\{previous_correction_files\[@\]\}"/
  );
  assert.match(
    guards[1],
    /assert_regular_blobs "\$SOCIAL_3B0_O05_CORRECTION_COMMIT" "\$\{o05_correction_files\[@\]\}"/
  );
  assert.match(
    guards[1],
    /assert_regular_blobs "\$SOCIAL_3B0_O12_CORRECTION_COMMIT" "\$\{o12_correction_files\[@\]\}"/
  );
  assert.match(
    guards[1],
    /assert_regular_blobs HEAD "\$\{current_correction_files\[@\]\}"/
  );
});

test("Windows runs the locked full suite naturally and exactly once", () => {
  const windows = WORKFLOW.jobs["windows-automated-tests"];
  assert.equal(windows["runs-on"], "windows-2025");
  assert.equal(windows["timeout-minutes"], 60);

  const checkout = windows.steps[0];
  assert.equal(checkout.name, "Checkout the authorized six-commit correction chain");
  assert.equal(checkout.uses, ACTIONS.checkout);
  assert.deepEqual(checkout.with, {
    "fetch-depth": 0,
    "persist-credentials": false
  });
  assert.equal(
    step(windows, "Set up Node.js 24").with["node-version"],
    "24"
  );
  assert.equal(
    step(windows, "Install locked dependencies without lifecycle scripts").run,
    "npm ci --ignore-scripts --no-audit --no-fund"
  );

  const suite = step(
    windows,
    "Run the stabilized complete Windows suite exactly once"
  );
  assert.deepEqual(Object.keys(suite.env).sort(), [
    "PGBIN",
    "PGDATA",
    "PGPASSWORD",
    "PGROOT",
    "PGUSER"
  ]);
  assert.ok(Object.values(suite.env).every((value) => value === ""));
  const command = "& 'C:\\Program Files\\nodejs\\npm.cmd' test";
  assert.equal(occurrences(suite.run, command), 1);
  assert.equal(occurrences(suite.run, "npm test"), 0);
  assert.match(suite.run, /\^PG\[A-Z0-9_\]\+\$/);
  assert.match(suite.run, /exit \$testStatus/);
  const finalWindows = step(
    windows,
    "Confirm the Windows suite left Git unchanged"
  );
  assert.equal(finalWindows.if, "always()");
  assert.match(finalWindows.run, /Get-Process -Name node,nodejs,postgres/);
  assert.match(finalWindows.run, /Get-NetTCPConnection -State Listen/);
});

test("Linux pre-gate is closed and the combined supervisor is invoked once", () => {
  const linux = WORKFLOW.jobs["linux-physical-validation"];
  assert.equal(linux["runs-on"], "ubuntu-24.04");
  assert.equal(linux["timeout-minutes"], 60);
  assert.equal(
    linux.steps[0].name,
    "Checkout the authorized six-commit correction chain"
  );
  const preGate = step(linux, "Run the closed Linux pre-gate tests exactly once");
  assert.equal(
    occurrences(preGate.run, "node scripts/social-3a0p-linux-pre-gate-tests.js"),
    1
  );
  assert.equal(occurrences(preGate.run, "node --test"), 1);
  assert.ok(
    preGate.run.indexOf("node scripts/social-3a0p-linux-pre-gate-tests.js") <
      preGate.run.indexOf("node --test")
  );
  assert.equal(
    occurrences(preGate.run, "tests/social-3a0p-local-scope.test.js"),
    0
  );
  for (const file of PRE_GATE_TEST_FILES) {
    assert.equal(occurrences(preGate.run, file), 1);
  }

  const gate = step(
    linux,
    "Run the combined Gates 1-5 and Social 3B-0 supervisor exactly once"
  );
  assert.equal(
    occurrences(gate.run, "node scripts/social-3b0-linux-physical-gate.js"),
    1
  );
  assert.match(
    gate.run,
    /--output "\$evidence_dir\/social-3b0-instagram-oauth-local-contract-evidence\.json" --process-status-output "\$evidence_dir\/social-3b0-instagram-oauth-local-contract-process-status\.json"/
  );
  assert.match(gate.run, /test ! -e "\$evidence_dir"/);
  assert.doesNotMatch(gate.run, /(?:mkdir|install -d)/);
  assert.doesNotMatch(
    WORKFLOW_TEXT,
    /node scripts\/social-3a0p-linux-gate\.js/
  );
  assert.deepEqual(gate.env, {
    SOCIAL_3B0_BRANCH: "${{ github.ref_name }}",
    SOCIAL_3B0_SHA: "${{ github.sha }}",
    SOCIAL_3B0_RUN_ATTEMPT: "${{ github.run_attempt }}",
    SOCIAL_3B0_WINDOWS_STATUS: "passed",
    SOCIAL_3B0_PRE_GATE_STATUS: "${{ steps.pre_gate.outputs.status }}",
    SOCIAL_3B0_POSTGRES_IMAGE: IMAGE,
    SOCIAL_3A0P_POSTGRES_IMAGE: IMAGE,
    POSTGRES_CONNECTIVITY_MODE: "internal_bridge_direct_v1",
    POSTGRES_BACKUP_CONNECTIVITY_MODE:
      "logical_dns_to_internal_container_v1",
    SOCIAL_INSTAGRAM_ENABLED: "false",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false"
  });
});

test("remote secret-scan approval is bound to both physical scan origins", () => {
  const historic = sourceSection(
    PHYSICAL_GATE_TEXT,
    "async function runHistoricPhysicalGates",
    "function createStepLedger"
  );
  const oauth = sourceSection(
    PHYSICAL_GATE_TEXT,
    "async function runPhysicalOAuthContract",
    "function baseEvidence"
  );
  const publication = sourceSection(
    PHYSICAL_GATE_TEXT,
    "async function runInstagramOAuthPhysicalGate",
    "async function cleanupInstagramOAuthPhysicalGate"
  );
  const safety = sourceSection(
    PHYSICAL_GATE_TEXT,
    "function evidenceSafe",
    "function sanitizeProcessStatus"
  );

  for (const fragment of [
    "historic.evidenceSafe(evidence) === true",
    "entry?.name === \"secret_scan\"",
    "entry?.status === \"passed\"",
    "historicSecretScanPassed: secretScanPassed"
  ]) {
    assert.ok(historic.includes(fragment), fragment);
  }
  for (const fragment of [
    "ledger.run(\"O21\"",
    "sensitiveStrings",
    "containsSyntheticMarkerInTree",
    "scanDataDirectoryMarkers"
  ]) {
    assert.ok(oauth.includes(fragment), fragment);
  }
  for (const fragment of [
    "historicPhysicalPassed: historic.historicSecretScanPassed",
    "oauthEvidencePassed:",
    "canonicalJson(evidence)",
    "social_3b0_evidence_secret_scan_failed"
  ]) {
    assert.ok(publication.includes(fragment), fragment);
  }
  assert.match(
    safety,
    /status === "passed"[\s\S]+historicPhysicalPassed === true[\s\S]+oauthEvidencePassed === true/
  );
});

test("evidence approval is fail-closed, hash-bound, and preserves safe failure evidence", () => {
  const linux = WORKFLOW.jobs["linux-physical-validation"];
  const evidence = step(linux, "Approve only closed sanitized evidence");
  assert.equal(evidence.if, "always()");
  for (const file of ARTIFACT_FILES) assert.ok(evidence.run.includes(file));
  for (const fragment of [
    "const cleanupOperations = new Set(['network_guard_restore', 'http_server_close', 'state_envelope_destroy', 'vault_destroy', 'postgres_cleanup_call', 'postgres_cleanup_result', 'residual_validation'])",
    "const cleanupKeys = ['operation', 'causalCode', 'cleanupErrorCount', 'postgresCleanupCompleted', 'firstAttemptSyntheticMaterialsCleared', 'firstAttemptResiduals'].sort()",
    "const cleanupProvenance = evidence.cleanupFailureProvenance",
    "const cleanupProvenanceShape = cleanupProvenance === null ||",
    "const safe = cleanupProvenanceShape && evidenceSafe(evidence) === true",
    "evidenceSafe(evidence) === true",
    "sanitizeProcessStatus(processStatus) !== null",
    "verifySidecar(process.env.EVIDENCE_JSON, process.env.EVIDENCE_SHA)",
    "verifySidecar(process.env.PROCESS_JSON, process.env.PROCESS_SHA)",
    "evidence.phase === 'instagram_oauth_local_contract'",
    "evidence.externalMetaCalls === 0",
    "evidence.externalInstagramCalls === 0",
    "evidence.externalGraphApiCalls === 0",
    "evidence.externalRenderCalls === 0",
    "evidence.externalPublicationCalls === 0",
    "evidence.publicationCalls === 0",
    "evidence.realTokenCount === 0",
    "evidence.secretScan?.status === 'passed'",
    "evidence.secretScan?.historicPhysicalPassed === true",
    "evidence.secretScan?.oauthEvidencePassed === true",
    "evidence.status === 'passed'",
    "evidence.firstFailure === null",
    "evidence.substeps[21]?.id === 'O22'",
    "evidence.substeps[21]?.status === 'passed'",
    "evidence.cleanupFailureProvenance === null",
    "evidence.backupRestoreFailureProvenance === null",
    "evidence.cleanup?.cleanupCompleted === true"
  ]) {
    assert.ok(evidence.run.includes(fragment));
  }
  assert.equal(
    occurrences(evidence.run, "evidence.externalRenderCalls === 0"),
    1
  );
  assert.equal(
    occurrences(evidence.run, "String(index + 1).padStart(2, '0')"),
    1
  );
  assert.match(evidence.run, /\['G01', 'migrations'\]/);
  assert.match(evidence.run, /\['G05', 'backup_restore'\]/);
  assert.match(evidence.run, /upload=true; success=/);
  assert.match(
    evidence.run,
    /test "\$validation" = true \|\| test "\$validation" = false/
  );
  assert.match(
    evidence.run,
    /if test "\$validation_status" -eq 0.*then upload=true; success=/s
  );
  assert.match(evidence.run, /passed \? 'true' : 'false'/);
  assert.match(
    evidence.run,
    /if \(!safe\) process\.exit\(1\);.*process\.stdout\.write\(passed \? 'true' : 'false'\)/s
  );
  assert.match(
    evidence.run,
    /processStatus\.exitCode === 0.*processStatus\.signal === null.*processStatus\.timedOut === false/
  );
  assert.ok(
    evidence.run.indexOf("upload=true; success=\"$validation\"") >
      evidence.run.indexOf("process.stdout.write(passed ? 'true' : 'false')")
  );
});

test("artifact has exactly four explicit files and one SHA-pinned upload", () => {
  const linux = WORKFLOW.jobs["linux-physical-validation"];
  const upload = step(linux, "Upload the single sanitized evidence artifact");
  assert.equal(upload.uses, ACTIONS.uploadArtifact);
  assert.equal(upload.if, "always() && steps.evidence.outputs.upload == 'true'");
  assert.equal(upload.with.name, ARTIFACT_NAME);
  const paths = upload.with.path.split("\n");
  assert.equal(paths.length, 4);
  assert.deepEqual(
    paths.map((value) => value.slice(value.lastIndexOf("/") + 1)),
    ARTIFACT_FILES
  );
  assert.ok(paths.every((value) => value.includes(`/${ARTIFACT_NAME}/`)));
  assert.deepEqual(
    {
      missing: upload.with["if-no-files-found"],
      compression: upload.with["compression-level"],
      overwrite: upload.with.overwrite,
      hidden: upload.with["include-hidden-files"]
    },
    {
      missing: "error",
      compression: 0,
      overwrite: false,
      hidden: false
    }
  );
});

test("cleanup always follows upload and final enforcement closes every result", () => {
  const linux = WORKFLOW.jobs["linux-physical-validation"];
  const names = linux.steps.map((entry) => entry.name);
  const gateIndex = names.indexOf(
    "Run the combined Gates 1-5 and Social 3B-0 supervisor exactly once"
  );
  const evidenceIndex = names.indexOf("Approve only closed sanitized evidence");
  const uploadIndex = names.indexOf(
    "Upload the single sanitized evidence artifact"
  );
  const cleanupIndex = names.indexOf("Clean every owned disposable resource");
  const enforcementIndex = names.indexOf(
    "Enforce the single first-attempt result"
  );
  assert.ok(
    gateIndex < evidenceIndex &&
      evidenceIndex < uploadIndex &&
      uploadIndex < cleanupIndex &&
      cleanupIndex < enforcementIndex
  );

  const cleanup = linux.steps[cleanupIndex];
  assert.equal(cleanup.if, "always()");
  assert.equal(
    occurrences(cleanup.run, "node scripts/social-3b0-linux-physical-gate.js --cleanup"),
    1
  );
  const enforcement = linux.steps[enforcementIndex];
  assert.equal(enforcement.if, "always()");
  for (const name of [
    "GATE_EXIT_CODE",
    "CLEANUP_EXIT_CODE",
    "EVIDENCE_UPLOAD_APPROVED",
    "EVIDENCE_SUCCESS",
    "UPLOAD_OUTCOME"
  ]) {
    assert.ok(Object.hasOwn(enforcement.env, name));
  }
  assert.match(enforcement.run, /test "\$GATE_EXIT_CODE" = '0'/);
  assert.match(enforcement.run, /test "\$CLEANUP_EXIT_CODE" = '0'/);
  assert.match(enforcement.run, /test "\$EVIDENCE_UPLOAD_APPROVED" = 'true'/);
  assert.match(enforcement.run, /test "\$EVIDENCE_SUCCESS" = 'true'/);
  assert.match(enforcement.run, /test "\$UPLOAD_OUTCOME" = 'success'/);
  assert.match(enforcement.run, /test ! -e "\$RUNNER_TEMP\//);
  assert.match(enforcement.run, /git status --porcelain=v1 --untracked-files=all/);
});

test("workflow contains no alternate trigger, deployment, real OAuth, or stream capture", () => {
  for (const fragment of [
    "workflow_dispatch",
    "pull_request",
    "schedule",
    "secrets.",
    "environment:",
    "curl ",
    "wget ",
    "api.instagram.com",
    "graph.facebook.com",
    "render.com",
    "oauth/authorize?",
    "stdoutStored: true",
    "stderrStored: true"
  ]) {
    assert.equal(WORKFLOW_TEXT.includes(fragment), false, fragment);
  }
  assert.equal(occurrences(WORKFLOW_TEXT, "actions/upload-artifact@"), 1);
  assert.equal(occurrences(WORKFLOW_TEXT, "--cleanup"), 1);
});
