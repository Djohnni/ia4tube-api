"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const RELATIVE = ".github/workflows/social-3b0-exact-0004-runner-linux.yml";
const FILE = path.join(ROOT, ...RELATIVE.split("/"));
const BRANCH =
  "social/checkpoint-3b0-exact-0004-runner-linux-lf-pins-20260814";
const BASE = "13e38b875db2a220514fe06113663c517c975592";
const SOURCE_COMMIT = "dbd15e2c8a94a59c8b16158296220cdcb0eb5078";
const MESSAGE =
  "[run-social-3b0] validate exact 0004 runner with canonical LF pins";
const IMAGE =
  "docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const FUNCTIONAL_FILES = Object.freeze([
  "scripts/social-db-migrate.js",
  "src/persistence/postgres/migrations.js",
  "tests/social-postgres-migrations.test.js",
  "tests/social-postgres-real.test.js"
]);
const FORMER_WINDOWS_WORKTREE_PINS = Object.freeze([
  "526abe4b610d9c9ae9fb8af2b263f1e37974c3e3d8bc6a51cb8c1ba90f5816fd",
  "6b67afffc8342dc514078e49785eb54665a9a709ab9673ca770b788177354374",
  "6addd77503120f85905820363e9bcd4a697f65f93038fde99f98fb63812f1227"
]);
const EXACT13 = Object.freeze([
  ".github/workflows/social-3b0-exact-0004-runner-linux.yml",
  "scripts/run-node-tests.js",
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

test("Exact-0004 Linux workflow fixes branch, parent, message, first push and Exact13", () => {
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
  const guard = stepByName(currentJob, "Verify immutable Exact13 contract").run;
  assert.ok(guard.includes("git rev-parse HEAD^"));
  assert.ok(guard.includes("git rev-list --parents -n 1 HEAD"));
  assert.ok(guard.includes("git diff-tree --no-commit-id --name-only -r --no-renames -z"));
  assert.ok(guard.includes("${#actual[@]}") && guard.includes("${#expected[@]}"));
  assert.equal(EXACT13.length, 13);
  assert.equal(new Set(EXACT13).size, 13);
  assert.deepEqual(bashExpectedInventory(guard), EXACT13);
  const physical = stepByName(
    currentJob,
    "Run the one-shot PostgreSQL 18 Exact-0004 proof"
  );
  const finalize = stepByName(currentJob, "Finalize sanitized four-file evidence");
  const enforcement = stepByName(currentJob, "Enforce final Exact-0004 result");
  assert.deepEqual(inlineInventory(physical.run, "inventory"), EXACT13);
  assert.deepEqual(inlineInventory(finalize.run, "inventory"), EXACT13);
  assert.deepEqual(inlineInventory(enforcement.run, "expectedInventory"), EXACT13);
  assert.equal(source.includes("Exact12"), false);
  assert.equal(source.includes("exact12_contract_failed"), false);
  assert.equal((guard.match(/functional=\(/g) || []).length, 1);
  assert.ok(guard.includes("100644") && guard.includes("blob"));
});

test("functional pins come from canonical Git blobs after path clean filters", () => {
  const { workflow } = read();
  const guard = stepByName(
    job(workflow),
    "Verify immutable Exact13 contract"
  ).run;
  const pins = functionalPins(guard);
  assert.deepEqual(Object.keys(pins), FUNCTIONAL_FILES);
  let materializationDiffers = false;
  for (const file of FUNCTIONAL_FILES) {
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
  if (process.platform === "win32") assert.equal(materializationDiffers, true);
  for (const formerPin of FORMER_WINDOWS_WORKTREE_PINS) {
    assert.equal(Object.values(pins).includes(formerPin), false, formerPin);
  }
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

test("one-shot proof authenticates load, TAP totals, exact gates and first failure", () => {
  const { workflow } = read();
  const run = stepByName(
    job(workflow),
    "Run the one-shot PostgreSQL 18 Exact-0004 proof"
  ).run;
  for (const fragment of [
    "real PostgreSQL proves migrations, physical RLS, vault and reauthentication",
    "tests|pass|fail|skipped|cancelled",
    "planExactPassed=true",
    "applyExactPassed=true",
    "concurrencyPassed=true",
    "rollbackPassed=true",
    "firstFailure(code)",
    "StringDecoder",
    "createTapParser",
    "16*1024*1024",
    "8192",
    "1200s",
    "processGroupExists",
    "code===124||code===137",
    "'-KILL'",
    "result.facts"
  ]) assert.ok(run.includes(fragment), fragment);
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
  assert.equal(source.includes("closeProxy"), false);
});

test("evidence contract contains only sanitized identity, result and cleanup facts", () => {
  const { source } = read();
  for (const key of [
    "schemaVersion", "branch", "commit", "parent", "inventory", "runner",
    "nodeVersion", "postgresImageDigest", "postgresStarted",
    "testProcessStarted", "testFileLoaded", "testsDiscovered", "testsPassed",
    "testsFailed", "planExactPassed", "applyExactPassed", "concurrencyPassed",
    "rollbackPassed", "profileBefore", "profileAfter", "firstFailure",
    "cleanupCompleted", "residuals", "exitCode", "signal", "timedOut",
    "stdoutStored", "stderrStored"
  ]) assert.ok(source.includes(key), key);
  assert.equal(source.includes("process.env.DATABASE_URL"), false);
  assert.equal(source.includes("process.env.SOCIAL_MIGRATIONS_DATABASE_URL"), false);
  assert.equal(source.includes("process.env.PGPASSWORD"), false);
  assert.equal(source.includes("process.env.INSTAGRAM_APP_SECRET"), false);
});
