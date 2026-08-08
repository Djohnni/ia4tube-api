"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  IMAGE,
  IMAGE_DIGEST,
  assertExactLoopbackListener,
  createLinuxPostgres,
  dockerNames,
  generatedSecret,
  safeRunId
} = require("../scripts/social-3a0p-linux-postgres");

class FakePool extends EventEmitter {
  constructor(configuration) {
    super();
    this.configuration = configuration;
    this.options = configuration;
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
  }

  async query() {
    return {
      rows: [{
        version_num: "180004",
        encoding: "UTF8",
        checksums: "on",
        password_encryption: "scram-sha-256",
        datcollate: "C",
        datctype: "C",
        hba_scram: true,
        admin_password_scram: true,
        selected: 1
      }]
    };
  }

  async end() {}
}

function metrics() {
  return {
    register() {},
    unregister() {},
    observe() {},
    recordAcquisition() {}
  };
}

test("official PostgreSQL pin is complete and immutable for linux/amd64", () => {
  assert.equal(
    IMAGE,
    "docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568"
  );
  assert.match(IMAGE_DIGEST, /^sha256:[0-9a-f]{64}$/);
  assert.match(IMAGE, /postgres:18\.4-bookworm@sha256:/);
});

test("run identifiers and resource names are closed and deterministic", () => {
  assert.equal(safeRunId("linux-123456"), "linux-123456");
  assert.throws(() => safeRunId(""));
  assert.deepEqual(dockerNames("linux-123456"), dockerNames("linux-123456"));
  const names = dockerNames("linux-123456");
  assert.match(names.container, /^ia4tube-social-3a0p-pg-[0-9a-f]{12}$/);
  assert.match(names.network, /^ia4tube-social-3a0p-net-[0-9a-f]{12}$/);
  assert.match(names.volume, /^ia4tube-social-3a0p-data-[0-9a-f]{12}$/);
});

test("host listener proof requires one exact IPv4 loopback socket", () => {
  const exact = "LISTEN 0 4096 127.0.0.1:49152 0.0.0.0:*";
  assert.equal(assertExactLoopbackListener([exact], 49152), true);
  for (const rows of [
    [],
    [exact, exact],
    ["LISTEN 0 4096 0.0.0.0:49152 0.0.0.0:*"],
    ["LISTEN 0 4096 [::1]:49152 [::]:*"],
    ["LISTEN 0 4096 *:49152 *:*"]
  ]) {
    assert.throws(() => assertExactLoopbackListener(rows, 49152), {
      code: "linux_postgres_listener_exposure_invalid"
    });
  }
});

test("synthetic credential material is strong and canonical", () => {
  const secret = generatedSecret((size) => Buffer.alloc(size, 7));
  assert.ok(secret.length >= 43);
  assert.match(secret.toString("utf8"), /^[A-Za-z0-9_-]+$/);
  assert.match(secret.toString("utf8"), /[a-z]/);
  assert.match(secret.toString("utf8"), /[A-Z]/);
  assert.match(secret.toString("utf8"), /[0-9]/);
  assert.match(secret.toString("utf8"), /_/);
  secret.fill(0);
});

test("container start uses internal network and publishes only host loopback without secret arguments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-test-"));
  const calls = [];
  let containerPresent = false;
  let volumePresent = false;
  let networkPresent = false;
  const knownSecret = `aA0_${Buffer.alloc(48, 9).toString("base64url")}`;
  const randomBytes = (size) => size === 32 ? Buffer.alloc(32, 5) : Buffer.alloc(size, 9);
  const names = dockerNames("linux-314159");
  async function runCommand(executable, args, options = {}) {
    calls.push({ executable, args: [...args], environment: { ...(options.environment || {}) } });
    const result = (stdout = "", code = 0) => ({ code, signal: null, stdout, stderr: "" });
    if (executable === "ss") {
      return result(containerPresent ? "LISTEN 0 4096 127.0.0.1:49152 0.0.0.0:*\n" : "");
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return {
        code: 0,
        stdout: JSON.stringify({
          Os: "linux",
          Architecture: "amd64",
          RepoDigests: [`postgres@${IMAGE_DIGEST}`]
        }),
        signal: null,
        stderr: ""
      };
    }
    if (args[0] === "network" && args[1] === "create") networkPresent = true;
    if (args[0] === "volume" && args[1] === "create") volumePresent = true;
    if (args[0] === "run" && args.includes("--detach")) containerPresent = true;
    if (args[0] === "port") return result("127.0.0.1:49152\n");
    if (args[0] === "inspect" && args[1] === names.container) {
      return result(JSON.stringify({ "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] }));
    }
    if (args[0] === "ps") return result(containerPresent ? "container-id\n" : "");
    if (args[0] === "volume" && args[1] === "ls") return result(volumePresent ? `${names.volume}\n` : "");
    if (args[0] === "network" && args[1] === "ls") return result(networkPresent ? "network-id\n" : "");
    if (args[0] === "rm") containerPresent = false;
    if (args[0] === "volume" && args[1] === "rm") volumePresent = false;
    if (args[0] === "network" && args[1] === "rm") networkPresent = false;
    return result();
  }
  const postgres = createLinuxPostgres({
    runnerTemp: root,
    runId: "linux-314159",
    PoolClass: FakePool,
    metricsRegistry: metrics(),
    runnerUid: 1001,
    runnerGid: 127,
    runCommand,
    randomBytes
  });
  try {
    const result = await postgres.start();
    assert.equal(result.port, 49152);
    assert.equal(result.externalIpv4Listeners, 0);
    assert.equal(result.externalIpv6Listeners, 0);
    const network = calls.find((call) => call.args[0] === "network" && call.args[1] === "create");
    const start = calls.find((call) => call.args[0] === "run" && call.args.includes("--detach"));
    assert.ok(network.args.includes("--internal"));
    assert.ok(start.args.includes("127.0.0.1::5432"));
    assert.equal(start.args.includes("0.0.0.0::5432"), false);
    assert.equal(start.args.some((arg) => arg.includes("POSTGRES_PASSWORD=")), false);
    assert.equal(JSON.stringify(calls.map((call) => call.args)).includes(knownSecret), false);
    assert.ok(start.args.includes(names.network));
    assert.ok(start.args.includes("type=volume,src=" + names.volume + ",dst=/var/lib/postgresql"));
    assert.ok(start.args.includes("PGDATA=/var/lib/postgresql/18/docker"));
    const cleanup = await postgres.cleanup();
    assert.equal(cleanup.cleanupCompleted, true);
    assert.ok(calls.some((call) => call.args[0] === "rm" && call.args.includes("--volumes")));
    assert.equal((await postgres.cleanup()).cleanupCompleted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("database tools receive password only through child memory environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-tool-"));
  const calls = [];
  let containerPresent = false;
  let volumePresent = false;
  let networkPresent = false;
  const names = dockerNames("linux-271828");
  async function runCommand(executable, args, options = {}) {
    calls.push({ executable, args: [...args], environment: { ...(options.environment || {}) } });
    const result = (stdout = "", code = 0) => ({ code, signal: null, stdout, stderr: "" });
    if (executable === "ss") return result(containerPresent ? "LISTEN 0 4096 127.0.0.1:49153 0.0.0.0:*\n" : "");
    if (args[0] === "image" && args[1] === "inspect") {
      return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
    }
    if (args[0] === "network" && args[1] === "create") networkPresent = true;
    if (args[0] === "volume" && args[1] === "create") volumePresent = true;
    if (args[0] === "run" && args.includes("--detach")) containerPresent = true;
    if (args[0] === "port") return result("127.0.0.1:49153\n");
    if (args[0] === "inspect" && args[1] === names.container) {
      return result(JSON.stringify({ "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] }));
    }
    if (args[0] === "ps") return result(containerPresent ? "container-id\n" : "");
    if (args[0] === "volume" && args[1] === "ls") return result(volumePresent ? `${names.volume}\n` : "");
    if (args[0] === "network" && args[1] === "ls") return result(networkPresent ? "network-id\n" : "");
    if (args[0] === "rm") containerPresent = false;
    if (args[0] === "volume" && args[1] === "rm") volumePresent = false;
    if (args[0] === "network" && args[1] === "rm") networkPresent = false;
    return result();
  }
  const postgres = createLinuxPostgres({
    runnerTemp: root,
    runId: "linux-271828",
    PoolClass: FakePool,
    metricsRegistry: metrics(),
    runnerUid: 1001,
    runnerGid: 127,
    runCommand,
    randomBytes: (size) => Buffer.alloc(size, 8)
  });
  await postgres.start();
  const password = `aA0_${Buffer.alloc(48, 8).toString("base64url")}`;
  const tool = postgres.createRunTool();
  await tool({
    executable: "/usr/bin/psql",
    args: ["--no-password", "--file=-"],
    env: {
      PGHOST: "127.0.0.1",
      PGPORT: "49153",
      PGDATABASE: "ia4tube_social_local",
      PGUSER: "ia4tube_social_local_migration",
      PGPASSWORD: password
    },
    input: "SELECT 1;"
  });
  const call = calls.at(-1);
  assert.deepEqual(call.args.slice(0, 4), ["exec", "--interactive", "--user", "1001:127"]);
  assert.ok(call.args.includes("PGPASSWORD"));
  assert.equal(call.args.some((argument) => argument.includes(password)), false);
  assert.equal(call.environment.PGPASSWORD, password);
  await postgres.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

test("cleanup is an idempotent success before any resource is created", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-empty-cleanup-"));
  const postgres = createLinuxPostgres({
    runnerTemp: root,
    runId: "linux-161803",
    PoolClass: FakePool,
    metricsRegistry: metrics(),
    runnerUid: 1001,
    runnerGid: 127,
    async runCommand(executable, args) {
      if (executable === "ss") return { code: 0, signal: null, stdout: "", stderr: "" };
      if (executable === "docker" && ["ps", "volume", "network"].includes(args[0])) {
        return { code: 0, signal: null, stdout: "", stderr: "" };
      }
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
    randomBytes: (size) => Buffer.alloc(size, 6)
  });
  try {
    assert.equal((await postgres.cleanup()).cleanupCompleted, true);
    assert.equal((await postgres.cleanup()).cleanupCompleted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
