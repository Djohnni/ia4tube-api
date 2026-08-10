"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const WORKFLOW_RELATIVE_PATH = ".github/workflows/social-3a0p-linux-physical-gates.yml";
const WORKFLOW_PATH = path.join(REPOSITORY_ROOT, ...WORKFLOW_RELATIVE_PATH.split("/"));
const BRANCH = "social/checkpoint-3a0p-linux-gate3-failure-provenance-20260809";
const FEATURE_PARENT = "8eb4c4d71c6593f9c3e448be6ac52b1b0e8ba931";
const MAINTENANCE_PARENT = "9b98de25a42a21f7ebd229bf5581a78bfed80b2e";
const MAINTENANCE_MESSAGE = "[test] serialize process-lifecycle security tests";
const ZERO_SHA = "0000000000000000000000000000000000000000";
const MESSAGE = "[run-social-3a0p-linux-gate] classify Gate 3 failure provenance";
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
const AUTHORIZED_FILES = Object.freeze([
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
const MAINTENANCE_FILES = Object.freeze([
  "scripts/run-node-tests.js",
  "scripts/social-3a0p-local-scope.js",
  "tests/node-test-runner-safety.test.js",
  "tests/social-3a0p-local-scope.test.js"
]);

function readWorkflow() {
  const source = fs.readFileSync(WORKFLOW_PATH, "utf8");
  return { source, workflow: JSON.parse(source) };
}

function onlyJob(workflow) {
  assert.deepEqual(Object.keys(workflow.jobs), ["physical-gates"]);
  return workflow.jobs["physical-gates"];
}

test("Linux gate is the repository's sole workflow and is strict JSON", () => {
  const workflowDirectory = path.dirname(WORKFLOW_PATH);
  const entries = fs.readdirSync(workflowDirectory, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].isFile(), true);
  assert.equal(entries[0].name, path.basename(WORKFLOW_PATH));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")));
});

test("workflow triggers only the exact authorized new-branch creation push", () => {
  const { workflow } = readWorkflow();
  assert.deepEqual(workflow.on, { push: { branches: [BRANCH] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "social-3a0p-linux-physical-gates",
    "cancel-in-progress": false
  });

  const job = onlyJob(workflow);
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 60);
  assert.equal(job.if, JOB_IF);
  assert.equal(workflow.env.SOCIAL_3A0P_AUTHORIZED_PARENT, FEATURE_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_MAINTENANCE_PARENT, MAINTENANCE_PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_MAINTENANCE_MESSAGE, MAINTENANCE_MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_AUTHORIZED_MESSAGE, MESSAGE);
  assert.equal(workflow.env.POSTGRES_CONNECTIVITY_MODE, "internal_bridge_direct_v1");
  assert.equal(
    workflow.env.POSTGRES_BACKUP_CONNECTIVITY_MODE,
    "logical_dns_to_internal_container_v1"
  );
  assert.equal(workflow.env.SOCIAL_3A0P_POSTGRES_IMAGE, IMAGE);

  const guard = job.steps.find((step) => step.name === "Verify immutable execution contract");
  assert.ok(guard.run.includes('test "$(git rev-parse HEAD^)" = "$SOCIAL_3A0P_AUTHORIZED_PARENT"'));
  assert.ok(guard.run.includes('test "$(git rev-parse "$SOCIAL_3A0P_AUTHORIZED_PARENT^")" = "$SOCIAL_3A0P_MAINTENANCE_PARENT"'));
  assert.ok(guard.run.includes('test "$(git log -1 --pretty=%B "$SOCIAL_3A0P_AUTHORIZED_PARENT")" = "$SOCIAL_3A0P_MAINTENANCE_MESSAGE"'));
  assert.ok(guard.run.includes('test "$(git rev-list --count "$SOCIAL_3A0P_MAINTENANCE_PARENT..HEAD")" = "2"'));
  assert.ok(guard.run.includes('test "$(git rev-list --parents -n 1 HEAD | wc -w)" = "2"'));
  assert.ok(guard.run.includes('test "$(git rev-list --parents -n 1 "$SOCIAL_3A0P_AUTHORIZED_PARENT" | wc -w)" = "2"'));
  assert.ok(guard.run.includes('test "$(git log -1 --pretty=%B)" = "$SOCIAL_3A0P_AUTHORIZED_MESSAGE"'));
  assert.ok(guard.run.includes('git diff --quiet "$SOCIAL_3A0P_PRODUCT_COMMIT" HEAD -- src db migrations roles.sql server.js package.json package-lock.json'));
  assert.ok(guard.run.includes('git diff --name-only "$SOCIAL_3A0P_MAINTENANCE_PARENT" "$SOCIAL_3A0P_AUTHORIZED_PARENT"'));
  assert.ok(guard.run.includes('git diff --name-only "$SOCIAL_3A0P_AUTHORIZED_PARENT" HEAD'));
  const maintenanceAllowlist = guard.run.match(
    /case "\$maintenance_changed" in\n\s+([^\n)]+)\) ;;/
  );
  const featureAllowlist = guard.run.match(
    /case "\$feature_changed" in\n\s+([^\n)]+)\) ;;/
  );
  assert.ok(maintenanceAllowlist);
  assert.ok(featureAllowlist);
  assert.deepEqual(maintenanceAllowlist[1].split("|"), MAINTENANCE_FILES);
  assert.deepEqual(featureAllowlist[1].split("|"), AUTHORIZED_FILES);
  assert.ok(guard.run.includes('test "$maintenance_count" = "4"'));
  assert.ok(guard.run.includes('test "$feature_count" = "9"'));
  assert.equal(maintenanceAllowlist[1].includes("*"), false);
  assert.equal(featureAllowlist[1].includes("*"), false);
  for (const file of MAINTENANCE_FILES) {
    assert.equal(AUTHORIZED_FILES.includes(file), false, file);
  }
  for (const forbidden of [
    "src/",
    "db/",
    "migrations/",
    "server.js",
    "package.json",
    "package-lock.json"
  ]) {
    assert.equal(featureAllowlist[1].includes(forbidden), false);
  }
  assert.equal(guard.run.includes(".github/workflows/*"), false);
  assert.equal(guard.run.includes("scripts/social-3a0p-linux-*"), false);
  assert.equal(guard.run.includes("scripts/social-3a0p-local-*"), false);
  assert.equal(guard.run.includes("tests/social-3a0p-linux-*"), false);
  assert.equal(guard.run.includes("tests/social-3a0p-local-*"), false);
  assert.equal(guard.run.includes("docs/social-3a0p-linux-*"), false);
  assert.equal(featureAllowlist[1].includes("social-3a0p-local-scope"), false);
});

test("workflow scope refuses globs, directories and every non-allowlisted path", () => {
  const { workflow } = readWorkflow();
  const guard = onlyJob(workflow).steps.find(
    (step) => step.name === "Verify immutable execution contract"
  );
  const allowlist = guard.run.match(
    /case "\$feature_changed" in\n\s+([^\n)]+)\) ;;/
  );
  assert.ok(allowlist);
  const accepted = new Set(allowlist[1].split("|"));
  assert.deepEqual([...accepted], [...AUTHORIZED_FILES]);

  for (const pathCandidate of [
    ".github/workflows/",
    ".github/workflows/*",
    ".github/workflows/other.yml",
    "scripts/social-3a0p-*",
    "scripts/social-3a0p-linux-postgres.js",
    "scripts/social-3a0p-local-backup-restore.js",
    "scripts/social-3a0p-local-connector-physical-gates-helper.js",
    "tests/social-3a0p-*",
    "tests/social-3a0p-linux-postgres.test.js",
    "tests/social-3a0p-local-backup-restore.test.js",
    "tests/social-3a0p-local-connector-physical-gates-extra.test.js",
    "docs/social-3a0p-*",
    "src/persistence/postgres/runtime-validation.js",
    "db/migrations/0004_social_connector_persistence.up.sql",
    "migrations/0004.sql",
    "server.js",
    "package.json",
    "package-lock.json"
  ]) {
    assert.equal(accepted.has(pathCandidate), false, pathCandidate);
  }
});

test("creation-push contract refuses wrong branch, parent, message, before, creation flag, and rerun", () => {
  const authorized = Object.freeze({
    eventName: "push",
    ref: `refs/heads/${BRANCH}`,
    parent: FEATURE_PARENT,
    created: true,
    deleted: false,
    forced: false,
    before: ZERO_SHA,
    message: MESSAGE,
    runAttempt: 1
  });
  const accepted = (event) => (
    event.eventName === "push" &&
    event.ref === `refs/heads/${BRANCH}` &&
    event.parent === FEATURE_PARENT &&
    event.created === true &&
    event.deleted === false &&
    event.forced === false &&
    event.before === ZERO_SHA &&
    event.message === MESSAGE &&
    event.runAttempt === 1
  );
  assert.equal(accepted(authorized), true);
  for (const mutation of [
    { ref: "refs/heads/social/checkpoint-3a0p-linux-runtime-attributes-oid-20260809" },
    { parent: "25b2669cfce85f8e2a2389c0ed128159dc6f83e1" },
    { before: FEATURE_PARENT },
    { message: "[run-social-3a0p-linux-gate] inspect runtime migration privileges by oid" },
    { created: false },
    { deleted: true },
    { forced: true },
    { runAttempt: 2 }
  ]) {
    assert.equal(accepted({ ...authorized, ...mutation }), false);
  }
});

test("workflow pins every action and installs the lockfile without scripts", () => {
  const { workflow } = readWorkflow();
  const steps = onlyJob(workflow).steps;
  assert.deepEqual(steps.filter((step) => step.uses).map((step) => step.uses), [
    ACTIONS.checkout,
    ACTIONS.setupNode,
    ACTIONS.uploadArtifact
  ]);
  for (const step of steps.filter((entry) => entry.uses)) {
    assert.match(step.uses, /^[a-z0-9_-]+\/[a-z0-9_-]+@[a-f0-9]{40}$/i);
  }

  const checkout = steps.find((step) => step.uses === ACTIONS.checkout);
  assert.deepEqual(checkout.with, { "fetch-depth": 0, "persist-credentials": false });
  const setupNode = steps.find((step) => step.uses === ACTIONS.setupNode);
  assert.deepEqual(setupNode.with, { "node-version": "24", "package-manager-cache": false });
  const install = steps.find((step) => step.name === "Install locked dependencies without lifecycle scripts");
  assert.equal(install.run, "npm ci --ignore-scripts --no-audit --no-fund");
  const automatedTests = steps.find(
    (step) => step.name === "Run stabilized automated tests once"
  );
  assert.equal(automatedTests.run, "npm test");
  assert.equal(steps.filter((step) => step.run === "npm test").length, 1);
  const installIndex = steps.indexOf(install);
  const automatedTestsIndex = steps.indexOf(automatedTests);
  const gateIndex = steps.findIndex((step) => step.id === "gate");
  assert.ok(installIndex < automatedTestsIndex);
  assert.ok(automatedTestsIndex < gateIndex);
});

test("workflow runs the physical gate exactly once and always cleans up", () => {
  const { source, workflow } = readWorkflow();
  const steps = onlyJob(workflow).steps;
  assert.equal(
    source.match(/node scripts\/social-3a0p-linux-gate\.js --supervise-run/g)?.length,
    1
  );
  assert.equal(source.includes("node scripts/social-3a0p-linux-gate.js --run"), false);
  assert.equal(source.match(/node scripts\/social-3a0p-linux-gate\.js --cleanup/g)?.length, 1);

  const gate = steps.find((step) => step.id === "gate");
  assert.equal(gate.if, undefined);
  assert.equal(
    gate.name,
    "Run Gate 3 failure provenance diagnostic once"
  );
  const cleanup = steps.find((step) => step.id === "cleanup");
  assert.equal(cleanup.if, "always()");
  const finalizer = steps.at(-1);
  assert.equal(finalizer.if, "always()");
  assert.ok(finalizer.run.includes("$GATE_EXIT_CODE"));
  assert.ok(finalizer.run.includes("$CLEANUP_EXIT_CODE"));
  assert.ok(finalizer.run.includes("$EVIDENCE_UPLOAD_APPROVED"));
});

test("workflow uploads one artifact only after sanitized evidence approval", () => {
  const { workflow } = readWorkflow();
  const steps = onlyJob(workflow).steps;
  const uploadSteps = steps.filter((step) => step.uses === ACTIONS.uploadArtifact);
  assert.equal(uploadSteps.length, 1);
  const upload = uploadSteps[0];
  assert.equal(upload.if, "always() && steps.evidence.outputs.upload == 'true'");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload.with.overwrite, false);
  assert.equal(upload.with["include-hidden-files"], false);
  assert.equal(
    upload.with.path,
    "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-physical-gates-evidence.json\n" +
      "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-physical-gates-evidence.sha256\n" +
      "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-gate-process-status.json\n" +
      "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-gate-process-status.sha256"
  );

  const approval = steps.find((step) => step.id === "evidence");
  assert.equal(approval.if, "always()");
  assert.ok(approval.run.includes("$RUNNER_TEMP/social-3a0p-linux-gate-evidence"));
  assert.ok(approval.run.includes("$sanitized_marker"));
  assert.ok(approval.run.includes("sha256sum"));
  assert.ok(approval.run.includes("$process_json"));
  assert.ok(approval.run.includes("$process_sha"));
  assert.ok(approval.run.includes("sanitizedGateProcessStatus"));
});

test("workflow stores only closed process status and never stores gate streams", () => {
  const { workflow } = readWorkflow();
  const gate = onlyJob(workflow).steps.find((step) => step.id === "gate");
  assert.ok(gate.run.includes("--supervise-run"));
  assert.equal(gate.run.includes("GATE_SHELL_STATUS"), false);
  assert.equal(gate.run.includes("stdoutStored:true"), false);
  assert.equal(gate.run.includes("stderrStored:true"), false);
  assert.equal(gate.run.includes("2>"), false);
  assert.equal(gate.run.includes("> gate"), false);
});

test("workflow has no broad trigger, secret, service, matrix or retry mechanism", () => {
  const { source, workflow } = readWorkflow();
  const job = onlyJob(workflow);
  for (const forbidden of [
    "workflow_dispatch",
    "pull_request",
    "schedule",
    "matrix",
    "retry",
    "secrets.",
    "0.0.0.0",
    "::/0"
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden workflow token: ${forbidden}`);
  }
  assert.equal(Object.hasOwn(job, "services"), false);
  assert.equal(Object.hasOwn(job, "strategy"), false);
  assert.equal(Object.hasOwn(workflow.on, "workflow_dispatch"), false);
  assert.equal(Object.hasOwn(workflow.on, "pull_request"), false);
  assert.equal(Object.hasOwn(workflow.on, "schedule"), false);
});
