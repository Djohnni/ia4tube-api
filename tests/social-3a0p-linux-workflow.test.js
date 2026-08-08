"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const WORKFLOW_RELATIVE_PATH = ".github/workflows/social-3a0p-linux-physical-gates.yml";
const WORKFLOW_PATH = path.join(REPOSITORY_ROOT, ...WORKFLOW_RELATIVE_PATH.split("/"));
const BRANCH = "social/checkpoint-3a0p-linux-physical-gates-20260807";
const PARENT = "36be098f926cc060ee89dff7874dab772a3ef22f";
const MESSAGE = "[run-social-3a0p-linux-gate] add isolated Linux physical gates";
const IMAGE = "docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const ACTIONS = Object.freeze({
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
});

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

test("workflow triggers only the exact first push and authorized commit message", () => {
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
  assert.match(job.if, /github\.event_name == 'push'/);
  assert.match(job.if, new RegExp(`refs/heads/${BRANCH.replaceAll("/", "\\/")}`));
  assert.ok(job.if.includes(`github.event.head_commit.message == '${MESSAGE}'`));
  assert.match(job.if, /github\.run_attempt == 1/);
  assert.match(job.if, /github\.event\.created == true/);
  assert.match(job.if, /github\.event\.forced == false/);
  assert.match(job.if, /github\.event\.before == '0{40}'/);
  assert.equal(workflow.env.SOCIAL_3A0P_AUTHORIZED_PARENT, PARENT);
  assert.equal(workflow.env.SOCIAL_3A0P_AUTHORIZED_MESSAGE, MESSAGE);
  assert.equal(workflow.env.SOCIAL_3A0P_POSTGRES_IMAGE, IMAGE);

  const guard = job.steps.find((step) => step.name === "Verify immutable execution contract");
  assert.ok(guard.run.includes("git rev-parse HEAD^"));
  assert.ok(guard.run.includes("$SOCIAL_3A0P_AUTHORIZED_PARENT"));
  assert.ok(guard.run.includes("git log -1 --pretty=%B"));
  assert.ok(guard.run.includes("$SOCIAL_3A0P_AUTHORIZED_MESSAGE"));
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
});

test("workflow runs the physical gate exactly once and always cleans up", () => {
  const { source, workflow } = readWorkflow();
  const steps = onlyJob(workflow).steps;
  assert.equal(source.match(/node scripts\/social-3a0p-linux-gate\.js --run/g)?.length, 1);
  assert.equal(source.match(/node scripts\/social-3a0p-linux-gate\.js --cleanup/g)?.length, 1);

  const gate = steps.find((step) => step.id === "gate");
  assert.equal(gate.if, undefined);
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
      "${{ runner.temp }}/social-3a0p-linux-gate-evidence/social-3a0p-linux-physical-gates-evidence.sha256"
  );

  const approval = steps.find((step) => step.id === "evidence");
  assert.equal(approval.if, "always()");
  assert.ok(approval.run.includes("$RUNNER_TEMP/social-3a0p-linux-gate-evidence"));
  assert.ok(approval.run.includes("$sanitized_marker"));
  assert.ok(approval.run.includes("sha256sum"));
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
