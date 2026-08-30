"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOW_PATH = path.join(
  ROOT,
  ".github",
  "workflows",
  "gate5a-postgres-0006-linux.yml"
);
const FOCAL_PATH = path.join(
  ROOT,
  "tests",
  "gate5a-postgres-0006-focal.test.js"
);
const BRANCH = "social/gate-5a-reviewer-readiness-staging-20260830";
const BASE = "08c6933168849c9fb5f5720af775fb746b74dbcd";
const MIGRATION_SHA =
  "f07eb68d37e8fec372e4b712447a113cba5d6ae6395492bb5678cc13d74948e7";
const IMAGE_SHA =
  "a10c981235b4f635e65df0cfb66a5598064628128505dbc6a3ed4ca303717521";

function workflow() {
  return JSON.parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
}

function onlyJob(value) {
  const entries = Object.entries(value.jobs || {});
  assert.equal(entries.length, 1);
  return entries[0][1];
}

function step(job, name) {
  const found = job.steps.find((item) => item.name === name);
  assert.ok(found, `missing workflow step: ${name}`);
  return found;
}

test("Gate 5A Linux route is a single push-only one-shot on the authorized branch", () => {
  const value = workflow();
  assert.deepEqual(value.on, { push: { branches: [BRANCH] } });
  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(value.concurrency, {
    group: "gate5a-postgres-0006-linux-one-shot",
    "cancel-in-progress": false
  });
  assert.equal(value.env.GATE5A_AUTHORIZED_PARENT, BASE);
  assert.equal(value.env.GATE5A_MIGRATION_SHA256, MIGRATION_SHA);
  assert.match(
    value.env.GATE5A_CANDIDATE_AGGREGATE_SHA256,
    /^[0-9a-f]{64}$/
  );
  assert.match(
    value.env.GATE5A_POSTGRES_IMAGE,
    new RegExp(`@sha256:${IMAGE_SHA}$`)
  );

  const job = onlyJob(value);
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 30);
  for (const boundary of [
    "github.event.created == true",
    "github.event.forced == false",
    "github.event.before == '0000000000000000000000000000000000000000'",
    "github.run_attempt == 1",
    "github.run_number == 1"
  ]) {
    assert.ok(job.if.includes(boundary));
  }
  assert.equal("strategy" in job, false);
  assert.equal("services" in job, false);
  assert.equal(JSON.stringify(value).includes("workflow_dispatch"), false);
  assert.equal(JSON.stringify(value).includes("workflow_call"), false);
});

test("Gate 5A Linux route runs only the focal in one isolated PostgreSQL container", () => {
  const job = onlyJob(workflow());
  const checkout = step(job, "Checkout the single authorized candidate");
  const setup = step(job, "Set up Node 24");
  const boundary = step(job, "Verify immutable one-shot boundary");
  const physical = step(job, "Run the single Gate 5A physical migration proof");
  const cleanup = step(
    job,
    "Remove the exact disposable route and prove zero residue"
  );

  assert.equal(
    checkout.uses,
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
  );
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(
    setup.uses,
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
  );
  assert.equal(setup.with["node-version"], "24");
  for (const protectedPath of [
    "package.json",
    "package-lock.json",
    ".github/workflows/social-3b0-instagram-oauth-local-contract.yml"
  ]) {
    assert.ok(boundary.run.includes(protectedPath), protectedPath);
  }
  for (const authenticatedBoundary of [
    '[[ "${GITHUB_RUN_NUMBER}" == "1" ]]',
    "candidate_paths=(",
    "digest_paths=(",
    "git diff --name-only HEAD^ HEAD",
    "GATE5A_CANDIDATE_AGGREGATE_SHA256"
  ]) {
    assert.ok(boundary.run.includes(authenticatedBoundary));
  }
  assert.equal(
    (boundary.run.match(/sha256sum/g) || []).length >= 3,
    true
  );
  assert.equal((physical.run.match(/docker run --rm/g) || []).length, 1);
  assert.ok(
    physical.run.includes(
      "timeout --signal=TERM --kill-after=30s 720s docker run --rm"
    )
  );
  for (const required of [
    "--platform linux/amd64",
    "--network none",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges",
    "--user 999:999",
    "dst=/workspace,readonly",
    "dst=/opt/node,readonly",
    "--test --test-reporter=spec /workspace/tests/gate5a-postgres-0006-focal.test.js"
  ]) {
    assert.ok(physical.run.includes(required), required);
  }
  assert.equal(physical.run.includes("DATABASE_URL"), false);
  assert.equal(physical.run.includes("instagram"), false);
  assert.equal(physical.run.includes("facebook"), false);
  assert.equal(physical.run.includes("npm test"), false);
  assert.equal(physical.run.includes("social-3a0p-linux-gate"), false);
  assert.equal(physical.run.includes("social-3b0-linux-physical-gate"), false);
  assert.equal(cleanup.if, "always()");
  assert.equal(cleanup.run.includes("|| true"), false);
  assert.ok(cleanup.run.includes("docker rm --force"));
  assert.equal(
    (
      cleanup.run.match(
        /docker ps --all --no-trunc --quiet --filter/g
      ) || []
    ).length,
    4
  );
  assert.ok(cleanup.run.includes('label=${label}'));
  assert.ok(cleanup.run.includes('name=^/${container_name}$'));
  assert.ok(cleanup.run.includes("sudo rm -rf --one-file-system"));
  assert.ok(cleanup.run.includes('if [[ "${cleanup_ok}" == "1" &&'));
  assert.ok(cleanup.run.includes('! -e "${proof_root}"'));
  assert.ok(cleanup.run.includes("exit 0"));
  assert.ok(cleanup.run.includes("exit 1"));
});

test("Gate 5A focal selects PostgreSQL 18 binaries by platform without changing its admission", () => {
  const source = fs.readFileSync(FOCAL_PATH, "utf8");
  assert.ok(source.includes('process.platform === "linux"'));
  assert.ok(source.includes('"/usr/lib/postgresql/18/bin"'));
  assert.ok(source.includes('process.platform === "win32" ? `${name}.exe` : name'));
  assert.ok(source.includes("unix_socket_directories=''"));
  assert.ok(source.includes(
    "I_AUTHORIZE_ONE_DISPOSABLE_POSTGRES_18_6_GATE5A_0006_RUN"
  ));
  assert.equal(source.includes("DATABASE_URL"), false);
  assert.equal(source.includes("SOCIAL_DATABASE_URL"), false);
});
