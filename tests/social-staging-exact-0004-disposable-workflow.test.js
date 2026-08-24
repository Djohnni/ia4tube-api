"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  APPROVAL,
  IMAGE_DIGEST,
  MODE,
  SYNTHETIC_ROLE_DROP_ORDER,
  forbiddenEnvironmentName,
  parseArguments,
  parseLoopbackAdminUrl,
  validateEvidence
} = require("../scripts/social-staging-exact-0004-disposable-proof");
const {
  EXACT_FROM_PROFILE,
  EXACT_TO_PROFILE,
  SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
  STAGING_EXACT_0004_SQL_SHA256
} = require("../src/persistence/postgres/migrations");

const root = path.join(__dirname, "..");
const workflowPath = path.join(
  root,
  ".github",
  "workflows",
  "social-staging-exact-0004-disposable.yml"
);
const scriptPath = path.join(
  root,
  "scripts",
  "social-staging-exact-0004-disposable-proof.js"
);
const branch = "social/checkpoint-3c0-staging-exact-preparation-20260824";
const failedCandidate = "6d40924489559ee0d4ffb4111931171c334127b7";
const digest = "a".repeat(64);

function workflow() {
  return JSON.parse(fs.readFileSync(workflowPath, "utf8"));
}

test("disposable staging-exact workflow has one restricted push route", () => {
  const value = workflow();
  assert.deepEqual(value.on, { push: { branches: [branch] } });
  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(value.concurrency, {
    group: "social-staging-exact-0004-disposable",
    "cancel-in-progress": false
  });
  const job = value.jobs["staging-exact-0004-disposable"];
  assert.match(job.if, /github\.event_name == 'push'/);
  assert.match(job.if, /github\.event\.created == false/);
  assert.match(job.if, /github\.event\.forced == false/);
  assert.match(job.if, new RegExp(`github\\.event\\.before == '${failedCandidate}'`));
  assert.match(job.if, /github\.run_attempt == 1/);
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 30);
  const checkout = job.steps[0];
  assert.equal(checkout.with["fetch-depth"], 2);
  const boundary = job.steps[1].run;
  assert.match(boundary, /git show -s --format=%P HEAD/);
  assert.match(boundary, new RegExp(failedCandidate));
  assert.match(boundary, /\[staging-exact\] fix PG18 disposable proof/);
  for (const file of [
    ".github/workflows/social-staging-exact-0004-disposable.yml",
    "scripts/social-staging-exact-0004-disposable-proof.js",
    "src/persistence/postgres/migrations.js",
    "tests/social-postgres-migrations.test.js",
    "tests/social-staging-exact-0004-disposable-workflow.test.js"
  ]) assert.match(boundary, new RegExp(file.replaceAll(".", "\\.")));
});

test("synthetic cleanup drops membership roles before their grantor", () => {
  assert.equal(Object.isFrozen(SYNTHETIC_ROLE_DROP_ORDER), true);
  assert.deepEqual(SYNTHETIC_ROLE_DROP_ORDER, [
    "ia4tube_social_staging_migration",
    "ia4tube_social_staging_runtime",
    "ia4tube_social_migrator",
    "ia4tube_social_runtime",
    "ia4tube_social_owner",
    "ia4tube_social_staging_user"
  ]);
});

test("workflow uses only a pinned local PostgreSQL 18.4 service", () => {
  const value = workflow();
  const service =
    value.jobs["staging-exact-0004-disposable"].services.postgres;
  assert.equal(
    service.image,
    `docker.io/library/postgres:18.4-bookworm@${IMAGE_DIGEST}`
  );
  assert.deepEqual(service.ports, ["5432:5432"]);
  assert.equal(service.env.POSTGRES_DB, "postgres");
  assert.equal(
    value.env.SOCIAL_STAGING_EXACT_DISPOSABLE_MODE,
    MODE
  );
  assert.equal(
    value.env.SOCIAL_STAGING_EXACT_DISPOSABLE_APPROVED,
    APPROVAL
  );
  assert.equal(
    value.env.SOCIAL_STAGING_EXACT_POSTGRES_IMAGE_DIGEST,
    IMAGE_DIGEST
  );
  const parsed = new URL(value.env.SOCIAL_STAGING_EXACT_DISPOSABLE_URL);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.port, "5432");
  assert.equal(parsed.pathname, "/postgres");
});

test("workflow actions are immutable and no real secret is referenced", () => {
  const value = workflow();
  const serialized = JSON.stringify(value);
  for (const step of
    value.jobs["staging-exact-0004-disposable"].steps) {
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(serialized, /\$\{\{\s*(?:secrets|vars)\./i);
  assert.doesNotMatch(serialized, /workflow_dispatch|schedule|pull_request/);
  assert.doesNotMatch(serialized, /on\.render\.com|graph\.facebook|instagram/i);
  assert.doesNotMatch(serialized, /social-db-migrate\.js/);
  assert.match(serialized, /--run/);
  assert.match(serialized, /--verify/);
  assert.match(serialized, /catalog-0003\.json/);
  assert.match(serialized, /catalog-0004\.json/);
  const steps = value.jobs["staging-exact-0004-disposable"].steps;
  const contract = steps.find((step) =>
    step.name === "Validate the disposable workflow contract"
  );
  for (const file of [
    "tests/social-postgres-migrations.test.js",
    "tests/social-postgres-staging-exact-0004-cli.test.js",
    "tests/social-postgres-staging-exact-0004.test.js",
    "tests/social-staging-exact-0004-disposable-workflow.test.js"
  ]) assert.match(contract.run, new RegExp(file.replaceAll(".", "\\.")));
  assert.equal(steps.at(-1).name, "Remove local evidence and confirm clean checkout");
  assert.equal(steps.at(-1).if, "always()");
});

test("proof harness calls the dedicated route and owns complete cleanup", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /\.planStagingExact\(/);
  assert.match(source, /\.applyStagingExact\(/);
  assert.match(source, /readStagingExactCatalogSnapshot/);
  assert.match(source, /stagingExactCatalogDigest/);
  assert.match(source, /DROP DATABASE IF EXISTS/);
  assert.match(source, /DROP ROLE IF EXISTS/);
  assert.match(source, /cleanupError/);
  assert.match(source, /staging_exact_disposable_cleanup_incomplete/);
  assert.match(source, /secondApplyRefused/);
  assert.match(source, /realStagingAccessed: false/);
  assert.doesNotMatch(source, /require\("node:(?:http|https|net|tls)"\)/);
  assert.doesNotMatch(source, /child_process/);
});

test("proof harness refuses external project credentials and non-loopback", () => {
  for (const name of [
    "DATABASE_URL",
    "SOCIAL_MIGRATIONS_DATABASE_URL",
    "SOCIAL_RUNTIME_DATABASE_URL",
    "RENDER_API_KEY",
    "META_ACCESS_TOKEN",
    "FACEBOOK_TOKEN",
    "INSTAGRAM_SECRET"
  ]) assert.equal(forbiddenEnvironmentName(name), true);
  assert.equal(forbiddenEnvironmentName("GITHUB_SHA"), false);

  assert.equal(
    parseLoopbackAdminUrl({
      SOCIAL_STAGING_EXACT_DISPOSABLE_URL:
        "postgresql://postgres:Synthetic_Exact_0004_Only%21@" +
        "127.0.0.1:5432/postgres"
    }).hostname,
    "127.0.0.1"
  );
  assert.throws(
    () => parseLoopbackAdminUrl({
      SOCIAL_STAGING_EXACT_DISPOSABLE_URL:
        "postgresql://postgres:Synthetic_Exact_0004_Only%21@" +
        "db.example.test:5432/postgres"
    }),
    { code: "staging_exact_disposable_url_not_loopback_admin" }
  );
});

test("proof evidence schema is synthetic, canonical, and zero-residual", () => {
  const evidence = {
    schemaVersion: 1,
    proof: "staging-exact-0004-disposable",
    synthetic: true,
    realStagingAccessed: false,
    renderAccessed: false,
    externalIntegrationsAccessed: false,
    postgres: { major: 18, imageDigest: IMAGE_DIGEST },
    route: {
      planReadOnly: true,
      applyOnce: true,
      syntheticTargetAdapter: true,
      actualConnectionLoopback: true,
      canonicalTargetMetadataOnly: true,
      postCommitValidated: true,
      secondApplyRefused: true,
      recoveryEvidenceExternallyVerified: false,
      migrationId: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
      migrationSha256: STAGING_EXACT_0004_SQL_SHA256
    },
    catalogs: {
      profile0003: {
        profile: EXACT_FROM_PROFILE,
        catalogSha256: digest
      },
      profile0004: {
        profile: EXACT_TO_PROFILE,
        catalogSha256: "b".repeat(64)
      }
    },
    residuals: {
      advisoryLocks: 0,
      databases: 0,
      roles: 0,
      sessions: 0,
      temporaryManifests: 0
    }
  };
  assert.equal(validateEvidence(evidence), true);
  assert.throws(
    () => validateEvidence({
      ...evidence,
      realStagingAccessed: true
    }),
    { code: "staging_exact_disposable_evidence_invalid" }
  );
  assert.deepEqual(
    parseArguments(["--run", "--output=/tmp/evidence"]),
    { mode: "--run", output: "/tmp/evidence" }
  );
});
