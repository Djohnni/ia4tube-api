"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const WORKFLOW_RELATIVE_PATH = ".github/workflows/social-3a0p-linux-physical-gates.yml";
const WORKFLOW_PATH = path.join(REPOSITORY_ROOT, ...WORKFLOW_RELATIVE_PATH.split("/"));
const BRANCH = "social/checkpoint-3a0p-windows-powershell-env-provenance-20260810";
const AUTHORIZED_PARENT = "02b8ae2ba09fecae4e0dac99bc2f8a6d557fc027";
const NATIVE_STABILITY_PARENT = "e2072df65d371fd7c0cf8429fb072dc437df2d27";
const ENVIRONMENT_CLEAN_PARENT = "7e6b0d8ed71daf75481f28a88832c4748f4ee648";
const IDENTIFICATION_PARENT = "aec92c0bf2a91608f69635fc459b28e125281fda";
const SANITIZATION_PARENT = "c5c211e27bd1db080234c890f06528192100c859";
const NATIVE_PREFLIGHT_PARENT = "b0d13299fb7226288e9a9d7bd531be751b539891";
const PROVENANCE_PARENT = "8eb4c4d71c6593f9c3e448be6ac52b1b0e8ba931";
const MAINTENANCE_PARENT = "9b98de25a42a21f7ebd229bf5581a78bfed80b2e";
const ENVIRONMENT_CLEAN_MESSAGE = "[run-social-3a0p-linux-gate] neutralize hosted Windows PostgreSQL defaults";
const IDENTIFICATION_MESSAGE = "[run-social-3a0p-linux-gate] identify hosted Windows PostgreSQL environment";
const SANITIZATION_MESSAGE = "[run-social-3a0p-linux-gate] sanitize hosted Windows PostgreSQL environment";
const NATIVE_PREFLIGHT_MESSAGE = "[run-social-3a0p-linux-gate] split native pre-gate test environments";
const PROVENANCE_MESSAGE = "[run-social-3a0p-linux-gate] classify Gate 3 failure provenance";
const MAINTENANCE_MESSAGE = "[test] serialize process-lifecycle security tests";
const NATIVE_STABILITY_MESSAGE = "[run-social-3a0p-linux-gate] stabilize hosted Windows native tests";
const MESSAGE = "[run-social-3a0p-linux-gate] diagnose hosted Windows PowerShell environment";
const ZERO_SHA = "0000000000000000000000000000000000000000";
const JOB_IF = [
  "github.event_name == 'push'",
  `github.ref == 'refs/heads/${BRANCH}'`,
  "github.event.created == true",
  "github.event.deleted == false",
  "github.event.forced == false",
  `github.event.before == '${ZERO_SHA}'`,
  `github.event.head_commit.message == '${MESSAGE}'`,
  "github.run_attempt == 1"
].join(" && ");
const IMAGE = "docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const ACTIONS = Object.freeze({
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
});
const MAINTENANCE_FILES = Object.freeze([
  "scripts/run-node-tests.js",
  "scripts/social-3a0p-local-scope.js",
  "tests/node-test-runner-safety.test.js",
  "tests/social-3a0p-local-scope.test.js"
]);
const PROVENANCE_FILES = Object.freeze([
  ".github/workflows/social-3a0p-linux-physical-gates.yml",
  "docs/social-3a0p-linux-physical-gates.md",
  "scripts/social-3a0p-linux-gate.js",
  "scripts/social-3a0p-local-connector-physical-gates.js",
  "scripts/social-3a0p-linux-physical-gates.js",
  "tests/social-3a0p-linux-gate.test.js",
  "tests/social-3a0p-local-connector-physical-gates.test.js",
  "tests/social-3a0p-linux-physical-gates.test.js",
  "tests/social-3a0p-linux-workflow.test.js"
]);
const NATIVE_PREFLIGHT_FILES = Object.freeze([
  ".github/workflows/social-3a0p-linux-physical-gates.yml",
  "docs/social-3a0p-linux-physical-gates.md",
  "scripts/social-3a0p-linux-gate.js",
  "scripts/social-3a0p-linux-pre-gate-tests.js",
  "tests/social-3a0p-linux-gate.test.js",
  "tests/social-3a0p-linux-pre-gate-tests.test.js",
  "tests/social-3a0p-linux-workflow.test.js"
]);
const SANITIZATION_FILES = Object.freeze([
  ".github/workflows/social-3a0p-linux-physical-gates.yml",
  "docs/social-3a0p-linux-physical-gates.md",
  "scripts/social-3a0p-linux-gate.js",
  "tests/social-3a0p-linux-gate.test.js",
  "tests/social-3a0p-linux-workflow.test.js"
]);
const IDENTIFICATION_FILES = Object.freeze([
  ".github/workflows/social-3a0p-linux-physical-gates.yml",
  "docs/social-3a0p-linux-physical-gates.md",
  "scripts/social-3a0p-linux-gate.js",
  "tests/social-3a0p-linux-gate.test.js",
  "tests/social-3a0p-linux-workflow.test.js"
]);
const ENVIRONMENT_CLEAN_FILES = Object.freeze([
  ".github/workflows/social-3a0p-linux-physical-gates.yml",
  "docs/social-3a0p-linux-physical-gates.md",
  "scripts/social-3a0p-linux-gate.js",
  "tests/social-3a0p-linux-gate.test.js",
  "tests/social-3a0p-linux-workflow.test.js"
]);
const NATIVE_STABILITY_FILES = Object.freeze([
  ".github/workflows/social-3a0p-linux-physical-gates.yml",
  "docs/social-3a0p-linux-physical-gates.md",
  "scripts/run-node-tests.js",
  "scripts/social-3a0p-linux-gate.js",
  "tests/node-test-runner-safety.test.js",
  "tests/social-3a0p-linux-gate.test.js",
  "tests/social-3a0p-linux-workflow.test.js",
  "tests/social-3a0p-local-firewall-nonmutation.test.js"
]);
const AUTHORIZED_FILES = Object.freeze([
  ".github/workflows/social-3a0p-linux-physical-gates.yml",
  "docs/social-3a0p-linux-physical-gates.md",
  "scripts/social-3a0p-linux-gate.js",
  "scripts/social-3a0p-windows-powershell-env-probe.js",
  "tests/social-3a0p-linux-gate.test.js",
  "tests/social-3a0p-linux-workflow.test.js",
  "tests/social-3a0p-windows-powershell-env-probe.test.js"
]);
const POWERSHELL_ENV_PROBE_COMMAND = "node scripts/social-3a0p-windows-powershell-env-probe.js";

function readWorkflow() {
  const source = fs.readFileSync(WORKFLOW_PATH, "utf8");
  return { source, workflow: JSON.parse(source) };
}

function jobs(workflow) {
  assert.deepEqual(Object.keys(workflow.jobs), [
    "windows-automated-tests",
    "physical-gates"
  ]);
  return Object.freeze({
    windows: workflow.jobs["windows-automated-tests"],
    physical: workflow.jobs["physical-gates"]
  });
}

function extractQuotedArray(source, declaration) {
  const escaped = declaration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\(\\n([\\s\\S]*?)\\n\\)`));
  assert.ok(match, declaration);
  return [...match[1].matchAll(/^\s+"([^"]+)",?$/gm)].map((entry) => entry[1]);
}

function assertGuardInventory(source, style) {
  const declarations = style === "powershell"
    ? [
        "$maintenanceFiles = @",
        "$provenanceFiles = @",
        "$nativePreflightFiles = @",
        "$sanitizationFiles = @",
        "$identificationFiles = @",
        "$environmentCleanFiles = @",
        "$nativeStabilityFiles = @",
        "$authorizedFiles = @"
      ]
    : [
        "maintenance_files=",
        "provenance_files=",
        "native_preflight_files=",
        "sanitization_files=",
        "identification_files=",
        "environment_clean_files=",
        "native_stability_files=",
        "authorized_files="
      ];
  assert.deepEqual(extractQuotedArray(source, declarations[0]), MAINTENANCE_FILES);
  assert.deepEqual(extractQuotedArray(source, declarations[1]), PROVENANCE_FILES);
  assert.deepEqual(extractQuotedArray(source, declarations[2]), NATIVE_PREFLIGHT_FILES);
  assert.deepEqual(extractQuotedArray(source, declarations[3]), SANITIZATION_FILES);
  assert.deepEqual(extractQuotedArray(source, declarations[4]), IDENTIFICATION_FILES);
  assert.deepEqual(extractQuotedArray(source, declarations[5]), ENVIRONMENT_CLEAN_FILES);
  assert.deepEqual(extractQuotedArray(source, declarations[6]), NATIVE_STABILITY_FILES);
  assert.deepEqual(extractQuotedArray(source, declarations[7]), AUTHORIZED_FILES);
  assert.equal(source.includes("*"), false);
}

test("PowerShell environment probe is the repository's sole workflow and is strict JSON", () => {
  const entries = fs.readdirSync(path.dirname(WORKFLOW_PATH), { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].isFile(), true);
  assert.equal(entries[0].name, path.basename(WORKFLOW_PATH));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")));
});

test("workflow permits only the exact first creation push and has two ordered native jobs", () => {
  const { workflow } = readWorkflow();
  const { windows, physical } = jobs(workflow);
  assert.deepEqual(workflow.on, { push: { branches: [BRANCH] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "social-3a0p-windows-powershell-env-provenance",
    "cancel-in-progress": false
  });

  assert.equal(windows.if, JOB_IF);
  assert.equal(windows["runs-on"], "windows-2025");
  assert.equal(windows["timeout-minutes"], 60);
  assert.deepEqual(windows.defaults, { run: { shell: "pwsh" } });
  assert.equal(Object.hasOwn(windows, "needs"), false);
  assert.equal(Object.hasOwn(windows, "env"), false);

  assert.equal(physical.if, JOB_IF);
  assert.equal(physical.needs, "windows-automated-tests");
  assert.equal(physical.if.includes("always()"), false);
  assert.equal(physical["runs-on"], "ubuntu-24.04");
  assert.equal(physical["timeout-minutes"], 60);
  assert.deepEqual(physical.defaults, { run: { shell: "bash" } });
  assert.deepEqual(physical.env, {
    POSTGRES_CONNECTIVITY_MODE: "internal_bridge_direct_v1",
    POSTGRES_BACKUP_CONNECTIVITY_MODE: "logical_dns_to_internal_container_v1",
    SOCIAL_3A0P_POSTGRES_IMAGE: IMAGE
  });
});

test("both jobs enforce the diagnostic commit and preserve all seven earlier commit contracts", () => {
  const { workflow } = readWorkflow();
  const { windows, physical } = jobs(workflow);
  assert.equal(workflow.env.SOCIAL_3A0P_AUTHORIZED_PARENT, AUTHORIZED_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_NATIVE_STABILITY_PARENT, NATIVE_STABILITY_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT, ENVIRONMENT_CLEAN_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_IDENTIFICATION_PARENT, IDENTIFICATION_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_SANITIZATION_PARENT, SANITIZATION_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT, NATIVE_PREFLIGHT_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_PROVENANCE_PARENT, PROVENANCE_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_MAINTENANCE_PARENT, MAINTENANCE_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_ENVIRONMENT_CLEAN_MESSAGE, ENVIRONMENT_CLEAN_MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_IDENTIFICATION_MESSAGE, IDENTIFICATION_MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_SANITIZATION_MESSAGE, SANITIZATION_MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_NATIVE_PREFLIGHT_MESSAGE, NATIVE_PREFLIGHT_MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_PROVENANCE_MESSAGE, PROVENANCE_MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_MAINTENANCE_MESSAGE, MAINTENANCE_MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_NATIVE_STABILITY_MESSAGE, NATIVE_STABILITY_MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_AUTHORIZED_MESSAGE, MESSAGE);

  const windowsGuard = windows.steps.find((step) => step.name === "Verify immutable execution contract");
  const linuxGuard = physical.steps.find((step) => step.name === "Verify immutable execution contract");
  assert.deepEqual(windowsGuard.env, linuxGuard.env);
  assert.deepEqual(windowsGuard.env, {
    AUTHORIZED_SHA: "${{ github.sha }}",
    AUTHORIZED_MESSAGE: "${{ github.event.head_commit.message }}",
    AUTHORIZED_ATTEMPT: "${{ github.run_attempt }}"
  });

  assertGuardInventory(windowsGuard.run, "powershell");
  assertGuardInventory(linuxGuard.run, "bash");
  for (const guard of [windowsGuard.run, linuxGuard.run]) {
    assert.ok(guard.includes("SOCIAL_3A0P_AUTHORIZED_PARENT"));
    assert.ok(guard.includes("SOCIAL_3A0P_NATIVE_STABILITY_PARENT"));
    assert.ok(guard.includes("SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT"));
    assert.ok(guard.includes("SOCIAL_3A0P_IDENTIFICATION_PARENT"));
    assert.ok(guard.includes("SOCIAL_3A0P_SANITIZATION_PARENT"));
    assert.ok(guard.includes("SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT"));
    assert.ok(guard.includes("SOCIAL_3A0P_PROVENANCE_PARENT"));
    assert.ok(guard.includes("SOCIAL_3A0P_MAINTENANCE_PARENT"));
    assert.ok(guard.includes("SOCIAL_3A0P_ENVIRONMENT_CLEAN_MESSAGE"));
    assert.ok(guard.includes("SOCIAL_3A0P_IDENTIFICATION_MESSAGE"));
    assert.ok(guard.includes("SOCIAL_3A0P_SANITIZATION_MESSAGE"));
    assert.ok(guard.includes("SOCIAL_3A0P_NATIVE_PREFLIGHT_MESSAGE"));
    assert.ok(guard.includes("SOCIAL_3A0P_PROVENANCE_MESSAGE"));
    assert.ok(guard.includes("SOCIAL_3A0P_MAINTENANCE_MESSAGE"));
    assert.ok(guard.includes("SOCIAL_3A0P_NATIVE_STABILITY_MESSAGE"));
    assert.ok(guard.includes("SOCIAL_3A0P_PRODUCT_COMMIT"));
    assert.ok(guard.includes("src"));
    assert.ok(guard.includes("db"));
    assert.ok(guard.includes("migrations"));
    assert.ok(guard.includes("roles.sql"));
    assert.ok(guard.includes("server.js"));
    assert.ok(guard.includes("package.json"));
    assert.ok(guard.includes("package-lock.json"));
    assert.ok(guard.includes("social-3a0p-linux-gate-evidence"));
  }
  assert.ok(windowsGuard.run.includes("$LASTEXITCODE"));
  for (const contract of [
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "HEAD")) $env:AUTHORIZED_SHA',
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "HEAD^")) $env:SOCIAL_3A0P_AUTHORIZED_PARENT',
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "$($env:SOCIAL_3A0P_AUTHORIZED_PARENT)^")) $env:SOCIAL_3A0P_NATIVE_STABILITY_PARENT',
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "$($env:SOCIAL_3A0P_NATIVE_STABILITY_PARENT)^")) $env:SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT',
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "$($env:SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT)^")) $env:SOCIAL_3A0P_IDENTIFICATION_PARENT',
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "$($env:SOCIAL_3A0P_IDENTIFICATION_PARENT)^")) $env:SOCIAL_3A0P_SANITIZATION_PARENT',
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "$($env:SOCIAL_3A0P_SANITIZATION_PARENT)^")) $env:SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT',
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "$($env:SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT)^")) $env:SOCIAL_3A0P_PROVENANCE_PARENT',
    'Assert-Equal (Get-GitText -Arguments @("rev-parse", "$($env:SOCIAL_3A0P_PROVENANCE_PARENT)^")) $env:SOCIAL_3A0P_MAINTENANCE_PARENT',
    'Assert-Equal (Get-GitText -Arguments @("log", "-1", "--pretty=%B")) $env:SOCIAL_3A0P_AUTHORIZED_MESSAGE',
    'Assert-Equal (Get-GitText -Arguments @("log", "-1", "--pretty=%B", $env:SOCIAL_3A0P_AUTHORIZED_PARENT)) $env:SOCIAL_3A0P_NATIVE_STABILITY_MESSAGE',
    'Assert-Equal (Get-GitText -Arguments @("log", "-1", "--pretty=%B", $env:SOCIAL_3A0P_NATIVE_STABILITY_PARENT)) $env:SOCIAL_3A0P_ENVIRONMENT_CLEAN_MESSAGE',
    'Assert-Equal (Get-GitText -Arguments @("log", "-1", "--pretty=%B", $env:SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT)) $env:SOCIAL_3A0P_IDENTIFICATION_MESSAGE',
    'Assert-Equal (Get-GitText -Arguments @("log", "-1", "--pretty=%B", $env:SOCIAL_3A0P_IDENTIFICATION_PARENT)) $env:SOCIAL_3A0P_SANITIZATION_MESSAGE',
    'Assert-Equal (Get-GitText -Arguments @("log", "-1", "--pretty=%B", $env:SOCIAL_3A0P_SANITIZATION_PARENT)) $env:SOCIAL_3A0P_NATIVE_PREFLIGHT_MESSAGE',
    'Assert-Equal (Get-GitText -Arguments @("log", "-1", "--pretty=%B", $env:SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT)) $env:SOCIAL_3A0P_PROVENANCE_MESSAGE',
    'Assert-Equal (Get-GitText -Arguments @("log", "-1", "--pretty=%B", $env:SOCIAL_3A0P_PROVENANCE_PARENT)) $env:SOCIAL_3A0P_MAINTENANCE_MESSAGE',
    'Assert-Equal (Get-GitText -Arguments @("rev-list", "--count", $commitRange)) "8"',
    'Assert-SingleParent "HEAD"',
    'Assert-SingleParent $env:SOCIAL_3A0P_AUTHORIZED_PARENT',
    'Assert-SingleParent $env:SOCIAL_3A0P_NATIVE_STABILITY_PARENT',
    'Assert-SingleParent $env:SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT',
    'Assert-SingleParent $env:SOCIAL_3A0P_IDENTIFICATION_PARENT',
    'Assert-SingleParent $env:SOCIAL_3A0P_SANITIZATION_PARENT',
    'Assert-SingleParent $env:SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT',
    'Assert-SingleParent $env:SOCIAL_3A0P_PROVENANCE_PARENT',
    'Assert-ExactFiles $maintenanceChanged $maintenanceFiles',
    'Assert-ExactFiles $provenanceChanged $provenanceFiles',
    'Assert-ExactFiles $nativePreflightChanged $nativePreflightFiles',
    'Assert-ExactFiles $sanitizationChanged $sanitizationFiles',
    'Assert-ExactFiles $identificationChanged $identificationFiles',
    'Assert-ExactFiles $environmentCleanChanged $environmentCleanFiles',
    'Assert-ExactFiles $nativeStabilityChanged $nativeStabilityFiles',
    'Assert-ExactFiles $authorizedChanged $authorizedFiles'
  ]) {
    assert.ok(windowsGuard.run.includes(contract), contract);
  }
  for (const contract of [
    'test "$(git rev-parse HEAD)" = "$AUTHORIZED_SHA"',
    'test "$(git rev-parse HEAD^)" = "$SOCIAL_3A0P_AUTHORIZED_PARENT"',
    'test "$(git rev-parse "$SOCIAL_3A0P_AUTHORIZED_PARENT^")" = "$SOCIAL_3A0P_NATIVE_STABILITY_PARENT"',
    'test "$(git rev-parse "$SOCIAL_3A0P_NATIVE_STABILITY_PARENT^")" = "$SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT"',
    'test "$(git rev-parse "$SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT^")" = "$SOCIAL_3A0P_IDENTIFICATION_PARENT"',
    'test "$(git rev-parse "$SOCIAL_3A0P_IDENTIFICATION_PARENT^")" = "$SOCIAL_3A0P_SANITIZATION_PARENT"',
    'test "$(git rev-parse "$SOCIAL_3A0P_SANITIZATION_PARENT^")" = "$SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT"',
    'test "$(git rev-parse "$SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT^")" = "$SOCIAL_3A0P_PROVENANCE_PARENT"',
    'test "$(git rev-parse "$SOCIAL_3A0P_PROVENANCE_PARENT^")" = "$SOCIAL_3A0P_MAINTENANCE_PARENT"',
    'test "$(git log -1 --pretty=%B)" = "$SOCIAL_3A0P_AUTHORIZED_MESSAGE"',
    'test "$(git log -1 --pretty=%B "$SOCIAL_3A0P_AUTHORIZED_PARENT")" = "$SOCIAL_3A0P_NATIVE_STABILITY_MESSAGE"',
    'test "$(git log -1 --pretty=%B "$SOCIAL_3A0P_NATIVE_STABILITY_PARENT")" = "$SOCIAL_3A0P_ENVIRONMENT_CLEAN_MESSAGE"',
    'test "$(git log -1 --pretty=%B "$SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT")" = "$SOCIAL_3A0P_IDENTIFICATION_MESSAGE"',
    'test "$(git log -1 --pretty=%B "$SOCIAL_3A0P_IDENTIFICATION_PARENT")" = "$SOCIAL_3A0P_SANITIZATION_MESSAGE"',
    'test "$(git log -1 --pretty=%B "$SOCIAL_3A0P_SANITIZATION_PARENT")" = "$SOCIAL_3A0P_NATIVE_PREFLIGHT_MESSAGE"',
    'test "$(git log -1 --pretty=%B "$SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT")" = "$SOCIAL_3A0P_PROVENANCE_MESSAGE"',
    'test "$(git log -1 --pretty=%B "$SOCIAL_3A0P_PROVENANCE_PARENT")" = "$SOCIAL_3A0P_MAINTENANCE_MESSAGE"',
    'assert_exact_changed_files "$SOCIAL_3A0P_MAINTENANCE_PARENT" "$SOCIAL_3A0P_PROVENANCE_PARENT" "${maintenance_files[@]}"',
    'assert_exact_changed_files "$SOCIAL_3A0P_PROVENANCE_PARENT" "$SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT" "${provenance_files[@]}"',
    'assert_exact_changed_files "$SOCIAL_3A0P_NATIVE_PREFLIGHT_PARENT" "$SOCIAL_3A0P_SANITIZATION_PARENT" "${native_preflight_files[@]}"',
    'assert_exact_changed_files "$SOCIAL_3A0P_SANITIZATION_PARENT" "$SOCIAL_3A0P_IDENTIFICATION_PARENT" "${sanitization_files[@]}"',
    'assert_exact_changed_files "$SOCIAL_3A0P_IDENTIFICATION_PARENT" "$SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT" "${identification_files[@]}"',
    'assert_exact_changed_files "$SOCIAL_3A0P_ENVIRONMENT_CLEAN_PARENT" "$SOCIAL_3A0P_NATIVE_STABILITY_PARENT" "${environment_clean_files[@]}"',
    'assert_exact_changed_files "$SOCIAL_3A0P_NATIVE_STABILITY_PARENT" "$SOCIAL_3A0P_AUTHORIZED_PARENT" "${native_stability_files[@]}"',
    'assert_exact_changed_files "$SOCIAL_3A0P_AUTHORIZED_PARENT" HEAD "${authorized_files[@]}"'
  ]) {
    assert.ok(linuxGuard.run.includes(contract), contract);
  }
  assert.ok(linuxGuard.run.includes('test "$(git rev-list --count "$SOCIAL_3A0P_MAINTENANCE_PARENT..HEAD")" = "8"'));
});

test("actions are pinned and each native job installs its own lockfile without cache or scripts", () => {
  const { workflow } = readWorkflow();
  const { windows, physical } = jobs(workflow);
  assert.deepEqual(windows.steps.filter((step) => step.uses).map((step) => step.uses), [
    ACTIONS.checkout,
    ACTIONS.setupNode
  ]);
  assert.deepEqual(physical.steps.filter((step) => step.uses).map((step) => step.uses), [
    ACTIONS.checkout,
    ACTIONS.setupNode,
    ACTIONS.uploadArtifact
  ]);

  for (const job of [windows, physical]) {
    for (const step of job.steps.filter((entry) => entry.uses)) {
      assert.match(step.uses, /^[a-z0-9_-]+\/[a-z0-9_-]+@[a-f0-9]{40}$/i);
    }
    const checkout = job.steps.find((step) => step.uses === ACTIONS.checkout);
    assert.deepEqual(checkout.with, { "fetch-depth": 0, "persist-credentials": false });
    const setup = job.steps.find((step) => step.uses === ACTIONS.setupNode);
    assert.deepEqual(setup.with, { "node-version": "24", "package-manager-cache": false });
    assert.equal(
      job.steps.filter((step) => step.run === "npm ci --ignore-scripts --no-audit --no-fund").length,
      1
    );
  }
});

test("Windows runs only the hosted PowerShell environment probe once after the locked install", () => {
  const { source, workflow } = readWorkflow();
  const { windows, physical } = jobs(workflow);
  assert.equal(source.includes("npm test"), false);
  assert.equal(source.match(/node scripts\/social-3a0p-windows-powershell-env-probe\.js/g)?.length, 1);
  assert.deepEqual(windows.steps.map((step) => step.name), [
    "Checkout authorized commit",
    "Verify immutable execution contract",
    "Set up Node.js",
    "Install locked dependencies without lifecycle scripts",
    "Run hosted Windows PowerShell environment probe once",
    "Confirm diagnostic probe left Git unchanged"
  ]);

  const probe = windows.steps.find(
    (step) => step.name === "Run hosted Windows PowerShell environment probe once"
  );
  assert.ok(probe);
  assert.equal(probe.run, POWERSHELL_ENV_PROBE_COMMAND);
  assert.equal(Object.hasOwn(probe, "env"), false);
  assert.equal(Object.hasOwn(probe, "if"), false);
  assert.equal(Object.hasOwn(probe, "continue-on-error"), false);
  assert.equal(Object.hasOwn(windows, "env"), false);
  assert.equal(Object.hasOwn(physical, "needs"), true);
  assert.equal(physical.needs, "windows-automated-tests");
  assert.equal(physical.if.includes("always()"), false);
  assert.equal(physical.steps.some((step) => step.run === POWERSHELL_ENV_PROBE_COMMAND), false);
  assert.equal(physical.steps.some((step) => step.run?.includes("npm test")), false);

  const installIndex = windows.steps.findIndex(
    (step) => step.run === "npm ci --ignore-scripts --no-audit --no-fund"
  );
  const probeIndex = windows.steps.indexOf(probe);
  const clean = windows.steps.find((step) => step.name === "Confirm diagnostic probe left Git unchanged");
  const cleanIndex = windows.steps.indexOf(clean);
  assert.ok(installIndex < probeIndex);
  assert.ok(probeIndex < cleanIndex);
  assert.equal(clean.if, "always()");
  assert.ok(clean.run.includes("git status --porcelain=v1 --untracked-files=all"));
  assert.ok(clean.run.includes("$LASTEXITCODE"));
  assert.ok(clean.run.includes("powershell_environment_probe_changed_git"));
  const operationalRuns = windows.steps
    .filter((step) => step.name !== "Verify immutable execution contract")
    .map((step) => step.run || "")
    .join("\n");
  for (const forbidden of [
    "npm test",
    "scripts/run-node-tests.js",
    "social-3a0p-linux-pre-gate-tests.js",
    "--supervise-run",
    "--cleanup",
    "upload-artifact",
    "POSTGRES_",
    "PGBIN",
    "PGDATA",
    "PGROOT",
    "PGPASSWORD",
    "PGUSER"
  ]) {
    assert.equal(operationalRuns.includes(forbidden), false, forbidden);
  }
});

test("Linux runs the closed pre-gate once before the single physical gate and never runs npm test", () => {
  const { source, workflow } = readWorkflow();
  const { windows, physical } = jobs(workflow);
  const preGateCommand = "node scripts/social-3a0p-linux-pre-gate-tests.js";
  assert.equal(source.match(/node scripts\/social-3a0p-linux-pre-gate-tests\.js/g)?.length, 1);
  assert.equal(windows.steps.some((step) => step.run === preGateCommand), false);
  const preGate = physical.steps.find((step) => step.run === preGateCommand);
  assert.equal(preGate.name, "Run closed Linux pre-gate tests once");
  assert.equal(Object.hasOwn(preGate, "if"), false);

  assert.equal(
    source.match(/node scripts\/social-3a0p-linux-gate\.js --supervise-run/g)?.length,
    1
  );
  assert.equal(source.includes("node scripts/social-3a0p-linux-gate.js --run"), false);
  assert.equal(source.match(/node scripts\/social-3a0p-linux-gate\.js --cleanup/g)?.length, 1);
  const installIndex = physical.steps.findIndex(
    (step) => step.run === "npm ci --ignore-scripts --no-audit --no-fund"
  );
  const preGateIndex = physical.steps.indexOf(preGate);
  const gate = physical.steps.find((step) => step.id === "gate");
  const gateIndex = physical.steps.indexOf(gate);
  assert.equal(Object.hasOwn(gate, "if"), false);
  assert.ok(installIndex < preGateIndex);
  assert.ok(preGateIndex < gateIndex);
});

test("only Linux can approve and upload the single sanitized artifact and cleanup is unconditional", () => {
  const { workflow } = readWorkflow();
  const { windows, physical } = jobs(workflow);
  assert.equal(windows.steps.some((step) => step.uses === ACTIONS.uploadArtifact), false);
  const uploadSteps = physical.steps.filter((step) => step.uses === ACTIONS.uploadArtifact);
  assert.equal(uploadSteps.length, 1);
  const upload = uploadSteps[0];
  assert.equal(upload.if, "always() && steps.evidence.outputs.upload == 'true'");
  assert.deepEqual(upload.with, {
    name: "social-3a0p-linux-physical-gates-evidence",
    path: "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-physical-gates-evidence.json\n" +
      "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-physical-gates-evidence.sha256\n" +
      "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-gate-process-status.json\n" +
      "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-gate-process-status.sha256",
    "if-no-files-found": "error",
    "compression-level": 0,
    overwrite: false,
    "include-hidden-files": false,
    "retention-days": 7
  });

  const approval = physical.steps.find((step) => step.id === "evidence");
  assert.equal(approval.if, "always()");
  for (const token of ["$sanitized_marker", "sha256sum", "$process_json", "$process_sha", "sanitizedGateProcessStatus"]) {
    assert.ok(approval.run.includes(token), token);
  }
  const cleanup = physical.steps.find((step) => step.id === "cleanup");
  assert.equal(cleanup.if, "always()");
  const finalizer = physical.steps.at(-1);
  assert.equal(finalizer.if, "always()");
  assert.ok(finalizer.run.includes("$GATE_EXIT_CODE"));
  assert.ok(finalizer.run.includes("$CLEANUP_EXIT_CODE"));
  assert.ok(finalizer.run.includes("$EVIDENCE_UPLOAD_APPROVED"));
});

test("workflow contains no alternate trigger, matrix, service, retry, secret, or stream capture", () => {
  const { source, workflow } = readWorkflow();
  const { windows, physical } = jobs(workflow);
  for (const forbidden of [
    "workflow_dispatch",
    "pull_request",
    "schedule",
    "matrix",
    "retry",
    "secrets.",
    "continue-on-error",
    "0.0.0.0",
    "::/0",
    "stdoutStored:true",
    "stderrStored:true",
    "2>",
    "> gate"
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  for (const job of [windows, physical]) {
    assert.equal(Object.hasOwn(job, "services"), false);
    assert.equal(Object.hasOwn(job, "strategy"), false);
  }
  assert.equal(Object.hasOwn(workflow.on, "workflow_dispatch"), false);
  assert.equal(Object.hasOwn(workflow.on, "pull_request"), false);
  assert.equal(Object.hasOwn(workflow.on, "schedule"), false);
});
