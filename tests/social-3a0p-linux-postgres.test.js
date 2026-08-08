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
  classifyHostListenerRows,
  createLinuxPostgres,
  dockerNames,
  generatedSecret,
  inspectContainerListing,
  inspectInternalContainer,
  inspectInternalNetwork,
  POSTGRES_CONNECTIVITY_MODE,
  safeRunId
} = require("../scripts/social-3a0p-linux-postgres");

const CONTAINER_ID = "a".repeat(64);
const NETWORK_ID = "b".repeat(64);
const PRIVATE_HOST = "172.30.0.2";

function networkInspection(names, overrides = {}) {
  const base = {
    Id: NETWORK_ID,
    Name: names.network,
    Scope: "local",
    Driver: "bridge",
    Internal: true,
    Attachable: false,
    Ingress: false,
    EnableIPv6: false,
    IPAM: {
      Driver: "default",
      Options: null,
      Config: [{ Subnet: "172.30.0.0/16", Gateway: "172.30.0.1" }]
    },
    Containers: {
      [CONTAINER_ID]: {
        Name: names.container,
        IPv4Address: `${PRIVATE_HOST}/16`,
        IPv6Address: ""
      }
    },
    Options: {},
    Labels: { "ia4tube.social3a0p.run": names.suffix }
  };
  return {
    ...base,
    ...overrides,
    IPAM: overrides.IPAM || base.IPAM,
    Containers: overrides.Containers || base.Containers,
    Options: overrides.Options || base.Options,
    Labels: overrides.Labels || base.Labels
  };
}

function containerInspection(names, overrides = {}) {
  const base = {
    Id: CONTAINER_ID,
    Name: `/${names.container}`,
    Config: { Labels: { "ia4tube.social3a0p.run": names.suffix } },
    State: { Running: true, Paused: false },
    HostConfig: {
      Privileged: false,
      NetworkMode: names.network,
      PortBindings: {},
      PublishAllPorts: false
    },
    NetworkSettings: {
      Ports: { "5432/tcp": null },
      Networks: {
        [names.network]: {
          NetworkID: NETWORK_ID,
          Gateway: "",
          IPAddress: PRIVATE_HOST,
          IPPrefixLen: 16,
          GlobalIPv6Address: ""
        }
      }
    }
  };
  return {
    ...base,
    ...overrides,
    Config: overrides.Config || base.Config,
    State: overrides.State || base.State,
    HostConfig: overrides.HostConfig || base.HostConfig,
    NetworkSettings: overrides.NetworkSettings || base.NetworkSettings
  };
}

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

test("host listener proof accepts only zero rows for PostgreSQL port 5432", () => {
  assert.equal(classifyHostListenerRows([], 5432), "none_observed");
  for (const rows of [
    ["LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*"],
    ["LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*"],
    ["LISTEN 0 4096 [::1]:5432 [::]:*"],
    ["LISTEN 0 4096 *:5432 *:*"]
  ]) {
    assert.throws(() => classifyHostListenerRows(rows, 5432), {
      code: "linux_postgres_listener_exposure_invalid"
    });
  }
  assert.throws(() => classifyHostListenerRows([], 49152), {
    code: "linux_postgres_listener_exposure_invalid"
  });
});

test("structured network and container inspections accept only the isolated unbound private bridge", () => {
  const names = dockerNames("linux-424242");
  const network = inspectInternalNetwork(JSON.stringify(networkInspection(names)), {
    networkId: NETWORK_ID,
    containerId: CONTAINER_ID,
    names,
    diagnostic: { networkCreated: true, containerCreated: true }
  });
  assert.equal(network.diagnostic.networkInternal, true);
  assert.equal(network.diagnostic.networkDriverClass, "bridge");
  const valid = inspectInternalContainer(JSON.stringify(containerInspection(names)), {
    containerId: CONTAINER_ID,
    networkId: NETWORK_ID,
    names,
    network,
    diagnostic: network.diagnostic
  });
  assert.equal(valid.databaseHost, PRIVATE_HOST);
  assert.equal(valid.diagnostic.containerRunning, true);
  assert.equal(valid.diagnostic.containerNetworkCount, 1);
  assert.equal(valid.diagnostic.containerIpWithinSubnet, true);
  assert.equal(valid.diagnostic.portBindingsAbsent, true);
  assert.equal(valid.diagnostic.publishedPortsAbsent, true);
  assert.equal(inspectContainerListing(JSON.stringify({
    ID: CONTAINER_ID,
    Names: names.container,
    Networks: names.network,
    Ports: "5432/tcp"
  }), { containerId: CONTAINER_ID, names }), true);

  const unboundAdditionalPort = containerInspection(names);
  unboundAdditionalPort.NetworkSettings.Ports["5433/tcp"] = null;
  assert.throws(() => inspectInternalContainer(JSON.stringify(unboundAdditionalPort), {
    containerId: CONTAINER_ID,
    networkId: NETWORK_ID,
    names,
    network
  }), { code: "linux_postgres_published_port_refused" });

  const changed = (operation) => {
    const value = containerInspection(names);
    operation(value);
    return JSON.stringify(value);
  };
  const cases = [
    ["", "linux_postgres_container_inspect_invalid"],
    ["not-json", "linux_postgres_container_inspect_invalid"],
    [changed((v) => { v.Id = "b".repeat(64); }), "linux_postgres_container_identity_invalid"],
    [changed((v) => { v.Name = "/different"; }), "linux_postgres_container_identity_invalid"],
    [changed((v) => { v.Config.Labels["ia4tube.social3a0p.run"] = "different"; }), "linux_postgres_container_identity_invalid"],
    [changed((v) => { v.State.Running = false; }), "linux_postgres_container_state_invalid"],
    [changed((v) => { v.State.Paused = true; }), "linux_postgres_container_state_invalid"],
    [changed((v) => { v.HostConfig.Privileged = true; }), "linux_postgres_container_security_invalid"],
    [changed((v) => { v.HostConfig.NetworkMode = "host"; }), "linux_postgres_container_security_invalid"],
    [changed((v) => { v.HostConfig.PublishAllPorts = true; }), "linux_postgres_container_security_invalid"],
    [changed((v) => { v.HostConfig.PortBindings = { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] }; }), "linux_postgres_published_port_refused"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"] = []; }), "linux_postgres_published_port_refused"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "49152" }]; }), "linux_postgres_published_port_refused"],
    [changed((v) => { v.NetworkSettings.Ports["5433/tcp"] = null; }), "linux_postgres_published_port_refused"],
    [changed((v) => { v.NetworkSettings.Networks.extra = { ...v.NetworkSettings.Networks[names.network] }; }), "linux_postgres_container_network_invalid"],
    [changed((v) => { v.NetworkSettings.Networks[names.network].NetworkID = "c".repeat(64); }), "linux_postgres_container_network_invalid"],
    [changed((v) => { v.NetworkSettings.Networks[names.network].IPAddress = ""; }), "linux_postgres_container_ip_invalid"],
    [changed((v) => { v.NetworkSettings.Networks[names.network].IPAddress = "not-an-ip"; }), "linux_postgres_container_ip_invalid"],
    [changed((v) => { v.NetworkSettings.Networks[names.network].IPAddress = "127.0.0.1"; }), "linux_postgres_container_ip_invalid"],
    [changed((v) => { v.NetworkSettings.Networks[names.network].IPAddress = "203.0.113.9"; }), "linux_postgres_container_ip_invalid"],
    [changed((v) => { v.NetworkSettings.Networks[names.network].IPAddress = "172.31.0.2"; }), "linux_postgres_container_ip_invalid"],
    [changed((v) => { v.NetworkSettings.Networks[names.network].IPPrefixLen = 24; }), "linux_postgres_container_ip_invalid"],
    [changed((v) => { v.NetworkSettings.Networks[names.network].Gateway = "172.30.0.1"; }), "linux_postgres_container_ip_invalid"]
  ];
  for (const [stdout, code] of cases) {
    assert.throws(
      () => inspectInternalContainer(stdout, { containerId: CONTAINER_ID, networkId: NETWORK_ID, names, network }),
      { code }
    );
  }
});

test("network inspection rejects unsafe bridge/IPAM shapes and diagnostics expose exactly 17 fields", () => {
  const names = dockerNames("linux-434343");
  const mutate = (operation) => {
    const value = networkInspection(names);
    operation(value);
    return JSON.stringify(value);
  };
  const cases = [
    [mutate((v) => { v.Id = "c".repeat(64); }), "linux_postgres_network_identity_invalid"],
    [mutate((v) => { v.Name = "other"; }), "linux_postgres_network_identity_invalid"],
    [mutate((v) => { v.Labels["ia4tube.social3a0p.run"] = "other"; }), "linux_postgres_network_identity_invalid"],
    [mutate((v) => { v.Driver = "host"; }), "linux_postgres_network_configuration_invalid"],
    [mutate((v) => { v.Internal = false; }), "linux_postgres_network_configuration_invalid"],
    [mutate((v) => { v.Attachable = true; }), "linux_postgres_network_configuration_invalid"],
    [mutate((v) => { v.Ingress = true; }), "linux_postgres_network_configuration_invalid"],
    [mutate((v) => { v.Options = { "com.docker.network.bridge.enable_ip_masquerade": "true" }; }), "linux_postgres_network_configuration_invalid"],
    [mutate((v) => { v.IPAM.Config[0].Subnet = "10.0.0.0/08"; }), "linux_postgres_network_ipam_invalid"],
    [mutate((v) => { v.IPAM.Config[0].Subnet = "172.30.1.0/16"; }), "linux_postgres_network_ipam_invalid"],
    [mutate((v) => { v.IPAM.Config[0].Subnet = "172.16.0.0/11"; }), "linux_postgres_network_ipam_invalid"],
    [mutate((v) => { v.IPAM.Config[0].Subnet = "192.168.0.0/15"; }), "linux_postgres_network_ipam_invalid"],
    [mutate((v) => { v.IPAM.Config[0].Subnet = "203.0.113.0/24"; }), "linux_postgres_network_ipam_invalid"],
    [mutate((v) => { v.IPAM.Config[0].Gateway = "203.0.113.1"; }), "linux_postgres_network_ipam_invalid"],
    [mutate((v) => { v.IPAM.Config.push({ Subnet: "10.0.0.0/24", Gateway: "10.0.0.1" }); }), "linux_postgres_network_ipam_invalid"],
    [mutate((v) => { v.Containers["c".repeat(64)] = { ...v.Containers[CONTAINER_ID] }; }), "linux_postgres_container_network_invalid"]
  ];
  for (const [stdout, code] of cases) {
    assert.throws(() => inspectInternalNetwork(stdout, {
      networkId: NETWORK_ID,
      containerId: CONTAINER_ID,
      names
    }), { code });
  }

  let observed;
  try { inspectInternalNetwork(cases[3][0], { networkId: NETWORK_ID, containerId: CONTAINER_ID, names }); } catch (error) { observed = error; }
  assert.deepEqual(Object.keys(observed.linuxPostgresDiagnostic).sort(), [
    "networkCreated", "networkInternal", "networkDriverClass", "containerCreated",
    "containerRunning", "containerNetworkCount", "containerIpPresent",
    "containerIpWithinSubnet", "portBindingsAbsent", "publishedPortsAbsent",
    "internalReadinessPassed", "hostDirectConnectionAttempted",
    "hostDirectConnectionPassed", "hostListenerAbsent", "failureStage",
    "sanitizedFailureCode", "cleanupCompleted"
  ].sort());
  assert.equal(JSON.stringify(observed).includes("172.30"), false);
  assert.equal(JSON.stringify(observed).includes(NETWORK_ID), false);
  assert.equal(observed.linuxPostgresDiagnostic.networkDriverClass, "other");
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

test("container start uses only the internal bridge and connects directly without host publishing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-test-"));
  const calls = [];
  let containerPresent = false;
  let volumePresent = false;
  let networkPresent = false;
  let failContainerRemoval = false;
  const knownSecret = `aA0_${Buffer.alloc(48, 9).toString("base64url")}`;
  const randomBytes = (size) => size === 32 ? Buffer.alloc(32, 5) : Buffer.alloc(size, 9);
  const names = dockerNames("linux-314159");
  async function runCommand(executable, args, options = {}) {
    calls.push({ executable, args: [...args], environment: { ...(options.environment || {}) } });
    const result = (stdout = "", code = 0) => ({ code, signal: null, stdout, stderr: "" });
    if (executable === "ss") return result();
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
    if (args[0] === "network" && args[1] === "create") {
      networkPresent = true;
      return result(`${NETWORK_ID}\n`);
    }
    if (args[0] === "volume" && args[1] === "create") volumePresent = true;
    if (args[0] === "run" && args.includes("--detach")) {
      containerPresent = true;
      return result(`${CONTAINER_ID}\n`);
    }
    if (args[0] === "inspect" && args.includes("--type=container")) {
      return result(JSON.stringify(containerInspection(names)));
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return result(JSON.stringify(networkInspection(names)));
    }
    if (args[0] === "ps" && args.includes("--format")) {
      return result(containerPresent ? `${JSON.stringify({ ID: CONTAINER_ID, Names: names.container, Networks: names.network, Ports: "5432/tcp" })}\n` : "");
    }
    if (args[0] === "ps") return result(containerPresent ? `${CONTAINER_ID}\n` : "");
    if (args[0] === "volume" && args[1] === "ls") return result(volumePresent ? `${names.volume}\n` : "");
    if (args[0] === "network" && args[1] === "ls") return result(networkPresent ? `${NETWORK_ID}\n` : "");
    if (args[0] === "rm") {
      if (failContainerRemoval) return result("", 1);
      containerPresent = false;
    }
    if (args[0] === "volume" && args[1] === "rm") volumePresent = false;
    if (args[0] === "network" && args[1] === "rm") networkPresent = false;
    return result();
  }
  class OrderedPool extends FakePool {
    constructor(configuration) {
      super(configuration);
      calls.push({ executable: "pool-create", args: [], configuration: { ...configuration }, environment: {} });
    }

    async query(...args) {
      calls.push({ executable: "pool", args: ["query", ...args], environment: {} });
      return super.query(...args);
    }
  }
  const postgres = createLinuxPostgres({
    runnerTemp: root,
    runId: "linux-314159",
    PoolClass: OrderedPool,
    metricsRegistry: metrics(),
    runnerUid: 1001,
    runnerGid: 127,
    runCommand,
    randomBytes
  });
  try {
    const result = await postgres.start();
    assert.equal(result.port, 5432);
    assert.equal(result.connectivityMode, POSTGRES_CONNECTIVITY_MODE);
    assert.equal(result.containerIdCaptured, true);
    assert.equal(result.containerIdMatched, true);
    assert.equal(result.structuredInspectCompleted, true);
    assert.equal(result.networkInternal, true);
    assert.equal(result.networkDriver, "bridge");
    assert.equal(result.containerAttachedNetworkCount, 1);
    assert.equal(result.publishedPortCount, 0);
    assert.equal(result.hostPortBindingAbsent, true);
    assert.equal(result.noHostPortPublished, true);
    assert.equal(result.internalBridgeDirectConnectionProved, true);
    assert.equal(result.hostDirectContainerIpConnectionPassed, true);
    assert.equal(result.hostListenerAbsent, true);
    assert.equal(JSON.stringify(result).includes(PRIVATE_HOST), false);
    const network = calls.find((call) => call.args[0] === "network" && call.args[1] === "create");
    const start = calls.find((call) => call.args[0] === "run" && call.args.includes("--detach"));
    assert.ok(network.args.includes("--internal"));
    assert.ok(network.args.includes("bridge"));
    assert.equal(start.args.includes("--publish"), false);
    assert.equal(start.args.includes("-p"), false);
    assert.equal(start.args.includes("-P"), false);
    assert.equal(start.args.some((argument) => argument.includes("127.0.0.1::")), false);
    assert.equal(start.args.some((arg) => arg.includes("POSTGRES_PASSWORD=")), false);
    assert.equal(JSON.stringify(calls.map((call) => call.args)).includes(knownSecret), false);
    assert.ok(start.args.includes(names.network));
    assert.ok(start.args.includes("type=volume,src=" + names.volume + ",dst=/var/lib/postgresql"));
    assert.ok(start.args.includes("PGDATA=/var/lib/postgresql/18/docker"));
    assert.equal(calls.some((call) => call.args[0] === "port"), false);
    const networkInspect = calls.find((call) => call.args[0] === "network" && call.args[1] === "inspect");
    assert.deepEqual(networkInspect.args, ["network", "inspect", "--format", "{{json .}}", NETWORK_ID]);
    const containerInspect = calls.find((call) => call.args[0] === "inspect" && call.args.includes("--type=container"));
    assert.deepEqual(containerInspect.args, [
      "inspect", "--type=container", "--format", "{{json .}}", CONTAINER_ID
    ]);
    assert.ok(calls.findIndex((call) => call.args[0] === "exec") < calls.indexOf(networkInspect));
    assert.ok(calls.indexOf(networkInspect) < calls.indexOf(containerInspect));
    assert.ok(calls.indexOf(containerInspect) < calls.findIndex((call) => call.executable === "pool"));
    const directPool = calls.find((call) => call.executable === "pool-create");
    assert.equal(directPool.configuration.host, PRIVATE_HOST);
    assert.equal(directPool.configuration.port, 5432);
    assert.equal(directPool.configuration.ssl, false);
    const directQuery = calls.find((call) => call.executable === "pool");
    assert.match(String(directQuery.args[1]), /1::integer AS selected/);
    const adapted = postgres.adaptLogicalPoolOptions({
      host: "127.0.0.1",
      port: 5432,
      database: "ia4tube_social_local",
      user: "ia4tube_social_local_migration",
      password: knownSecret,
      ssl: false,
      max: 1
    });
    assert.equal(adapted.host, PRIVATE_HOST);
    assert.equal(adapted.port, 5432);
    assert.throws(() => postgres.adaptLogicalPoolOptions(adapted), {
      code: "linux_postgres_logical_pool_transport_refused"
    });
    for (const refused of [
      { host: "127.0.0.1", port: 5433, ssl: false },
      { host: PRIVATE_HOST, port: 5432, ssl: false },
      { host: "127.0.0.1", port: 5432, ssl: true }
    ]) {
      assert.throws(() => postgres.adaptLogicalPoolOptions(refused), {
        code: "linux_postgres_logical_pool_transport_refused"
      });
    }
    failContainerRemoval = true;
    const failedCleanupStart = calls.length;
    await assert.rejects(postgres.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
    const failedCleanupCalls = calls.slice(failedCleanupStart);
    assert.equal(failedCleanupCalls.some((call) => call.args[0] === "rm" && call.args.includes(CONTAINER_ID)), true);
    assert.equal(failedCleanupCalls.some((call) => call.args[0] === "run"), false);
    assert.equal(failedCleanupCalls.some((call) => call.args[0] === "volume" && call.args[1] === "rm"), false);
    assert.equal(failedCleanupCalls.some((call) => call.args[0] === "network" && call.args[1] === "rm"), false);
    assert.equal(fs.existsSync(postgres.runRoot), true);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".identity")), true);

    failContainerRemoval = false;
    const cleanup = await postgres.cleanup();
    assert.equal(cleanup.cleanupCompleted, true);
    assert.ok(calls.some((call) => call.args[0] === "rm" && call.args.includes("--volumes")));
    assert.ok(calls.some((call) => call.args[0] === "rm" && call.args.includes(CONTAINER_ID)));
    assert.ok(calls.some((call) => call.args[0] === "ps" && call.args.includes("--no-trunc")));
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".identity")), false);
    assert.equal((await postgres.cleanup()).cleanupCompleted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid IDs, readiness, inspect and direct connection failures stay sanitized and clean", async () => {
  for (const scenario of [
    { runStdout: "", code: "linux_postgres_container_id_invalid", stage: "container_id" },
    { runStdout: "\n", code: "linux_postgres_container_id_invalid", stage: "container_id" },
    { runStdout: "abc\n", code: "linux_postgres_container_id_invalid", stage: "container_id" },
    { runStdout: ` ${CONTAINER_ID}\n`, code: "linux_postgres_container_id_invalid", stage: "container_id" },
    { runStdout: `${CONTAINER_ID}\n`, readinessFails: true, code: "linux_postgres_readiness_failed", stage: "internal_readiness" },
    { runStdout: `${CONTAINER_ID}\n`, networkInspectCode: 1, code: "linux_postgres_network_inspect_failed", stage: "network_inspect" },
    { runStdout: `${CONTAINER_ID}\n`, inspectCode: 1, code: "linux_postgres_container_inspect_failed", stage: "container_inspect" },
    { runStdout: `${CONTAINER_ID}\n`, listenerPresent: true, code: "linux_postgres_listener_exposure_invalid", stage: "host_listener" },
    { runStdout: `${CONTAINER_ID}\n`, poolFails: true, code: "linux_postgres_host_direct_connection_failed", stage: "host_direct_connection" },
    { runStdout: `${CONTAINER_ID}\n`, poolRow: { version_num: "180003" }, code: "linux_postgres_runtime_identity_invalid", stage: "host_direct_connection" },
    { runStdout: `${CONTAINER_ID}\n`, poolRow: { checksums: "off" }, code: "linux_postgres_runtime_identity_invalid", stage: "host_direct_connection" },
    { runStdout: `${CONTAINER_ID}\n`, poolRow: { password_encryption: "md5" }, code: "linux_postgres_runtime_identity_invalid", stage: "host_direct_connection" },
    { runStdout: `${CONTAINER_ID}\n`, poolRow: { hba_scram: false }, code: "linux_postgres_runtime_identity_invalid", stage: "host_direct_connection" },
    { runStdout: `${CONTAINER_ID}\n`, poolRow: { selected: 0 }, code: "linux_postgres_runtime_identity_invalid", stage: "host_direct_connection" }
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-failure-"));
    const names = dockerNames("linux-515151");
    let containerPresent = false;
    let volumePresent = false;
    let networkPresent = false;
    let ssCalls = 0;
    const calls = [];
    async function runCommand(executable, args) {
      calls.push([...args]);
      const result = (stdout = "", code = 0, stderr = "") => ({ code, signal: null, stdout, stderr });
      if (executable === "ss") {
        ssCalls += 1;
        return result(scenario.listenerPresent && ssCalls === 1
          ? "LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*\n"
          : "");
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
      }
      if (args[0] === "network" && args[1] === "create") {
        networkPresent = true;
        return result(`${NETWORK_ID}\n`);
      }
      if (args[0] === "volume" && args[1] === "create") volumePresent = true;
      if (args[0] === "run" && args.includes("--detach")) {
        containerPresent = true;
        return result(scenario.runStdout);
      }
      if (args[0] === "exec" && args.includes("pg_isready") && scenario.readinessFails) {
        return result("", 1, "not ready");
      }
      if (args[0] === "inspect" && args.includes("--type=container")) {
        return result(
          scenario.inspectCode ? "" : JSON.stringify(containerInspection(names)),
          scenario.inspectCode,
          scenario.inspectCode ? "sanitized failure" : ""
        );
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return result(
          scenario.networkInspectCode ? "" : JSON.stringify(networkInspection(names)),
          scenario.networkInspectCode || 0,
          scenario.networkInspectCode ? "sanitized failure" : ""
        );
      }
      if (args[0] === "ps" && args.includes("--format")) {
        return result(containerPresent ? `${JSON.stringify({ ID: CONTAINER_ID, Names: names.container, Networks: names.network, Ports: "5432/tcp" })}\n` : "");
      }
      if (args[0] === "ps") return result(containerPresent ? `${CONTAINER_ID}\n` : "");
      if (args[0] === "volume" && args[1] === "ls") return result(volumePresent ? `${names.volume}\n` : "");
      if (args[0] === "network" && args[1] === "ls") return result(networkPresent ? `${NETWORK_ID}\n` : "");
      if (args[0] === "rm") containerPresent = false;
      if (args[0] === "volume" && args[1] === "rm") volumePresent = false;
      if (args[0] === "network" && args[1] === "rm") networkPresent = false;
      return result();
    }
    class ScenarioPool extends FakePool {
      async query(...args) {
        if (scenario.poolFails) throw new Error("synthetic connection failure");
        const response = await super.query(...args);
        if (scenario.poolRow) Object.assign(response.rows[0], scenario.poolRow);
        return response;
      }
    }
    const postgres = createLinuxPostgres({
      runnerTemp: root,
      runId: "linux-515151",
      PoolClass: ScenarioPool,
      metricsRegistry: metrics(),
      runnerUid: 1001,
      runnerGid: 127,
      runCommand,
      readinessDelay: async () => {},
      randomBytes: (size) => Buffer.alloc(size, 4)
    });
    try {
      let observed;
      try { await postgres.start(); } catch (error) { observed = error; }
      assert.equal(observed.code, scenario.code);
      assert.equal(observed.linuxPostgresDiagnostic.failureStage, scenario.stage);
      assert.equal(observed.linuxPostgresDiagnostic.containerCreated, true);
      assert.equal(observed.linuxPostgresDiagnostic.hostDirectConnectionPassed, false);
      assert.equal(observed.linuxPostgresDiagnostic.sanitizedFailureCode, scenario.code);
      assert.equal(JSON.stringify(observed.linuxPostgresDiagnostic).includes("sanitized failure"), false);
      assert.equal((await postgres.cleanup()).cleanupCompleted, true);
      assert.ok(calls.some((args) => args[0] === "rm" && args.includes(CONTAINER_ID)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("cleanup refuses every resource mutation when the captured and discovered container IDs diverge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-identity-conflict-"));
  const names = dockerNames("linux-626262");
  const discoveredId = "b".repeat(64);
  const calls = [];
  let cleanupStarted = false;
  async function runCommand(executable, args) {
    calls.push({ executable, args: [...args], cleanupStarted });
    const result = (stdout = "", code = 0) => ({ code, signal: null, stdout, stderr: "" });
    if (executable === "ss") return result();
    if (args[0] === "image" && args[1] === "inspect") {
      return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
    }
    if (args[0] === "network" && args[1] === "create") return result(`${NETWORK_ID}\n`);
    if (args[0] === "run" && args.includes("--detach")) return result(`${CONTAINER_ID}\n`);
    if (args[0] === "network" && args[1] === "inspect") {
      return result(JSON.stringify(networkInspection(names)));
    }
    if (args[0] === "inspect" && args.includes("--type=container")) {
      return result(JSON.stringify(containerInspection(names)));
    }
    if (args[0] === "ps" && args.includes("--format")) {
      return result(`${JSON.stringify({ ID: CONTAINER_ID, Names: names.container, Networks: names.network, Ports: "5432/tcp" })}\n`);
    }
    if (args[0] === "ps") return result(cleanupStarted ? `${discoveredId}\n` : `${CONTAINER_ID}\n`);
    if (args[0] === "volume" && args[1] === "ls") return result(`${names.volume}\n`);
    if (args[0] === "network" && args[1] === "ls") return result(`${NETWORK_ID}\n`);
    return result();
  }
  const postgres = createLinuxPostgres({
    runnerTemp: root,
    runId: "linux-626262",
    PoolClass: FakePool,
    metricsRegistry: metrics(),
    runnerUid: 1001,
    runnerGid: 127,
    runCommand,
    randomBytes: (size) => Buffer.alloc(size, 5)
  });
  try {
    await postgres.start();
    assert.equal(fs.existsSync(postgres.runRoot), true);
    cleanupStarted = true;
    await assert.rejects(postgres.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
    await assert.rejects(postgres.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
    const cleanupOnly = createLinuxPostgres({
      runnerTemp: root,
      runId: "linux-626262",
      PoolClass: FakePool,
      metricsRegistry: metrics(),
      runnerUid: 1001,
      runnerGid: 127,
      runCommand,
      randomBytes: (size) => Buffer.alloc(size, 9)
    });
    await assert.rejects(cleanupOnly.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
    const cleanupCalls = calls.filter((call) => call.cleanupStarted && call.executable === "docker");
    assert.equal(cleanupCalls.some((call) => call.args[0] === "rm"), false);
    assert.equal(cleanupCalls.some((call) => call.args[0] === "run"), false);
    assert.equal(cleanupCalls.some((call) => call.args[0] === "volume" && call.args[1] === "rm"), false);
    assert.equal(cleanupCalls.some((call) => call.args[0] === "network" && call.args[1] === "rm"), false);
    assert.equal(fs.existsSync(postgres.runRoot), true);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".identity")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup refuses name or label drift even when the captured container remains globally visible", async () => {
  for (const drift of ["name", "label"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ia4tube-linux-pg-${drift}-drift-`));
    const runId = drift === "name" ? "linux-737373" : "linux-747474";
    const names = dockerNames(runId);
    const calls = [];
    let cleanupStarted = false;
    async function runCommand(executable, args) {
      calls.push({ executable, args: [...args], cleanupStarted });
      const result = (stdout = "", code = 0) => ({ code, signal: null, stdout, stderr: "" });
      if (executable === "ss") return result();
      if (args[0] === "image" && args[1] === "inspect") {
        return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
      }
      if (args[0] === "network" && args[1] === "create") return result(`${NETWORK_ID}\n`);
      if (args[0] === "run" && args.includes("--detach")) return result(`${CONTAINER_ID}\n`);
      if (args[0] === "network" && args[1] === "inspect") {
        return result(JSON.stringify(networkInspection(names)));
      }
      if (args[0] === "inspect" && args.includes("--type=container")) {
        const inspected = containerInspection(names);
        if (drift === "name") inspected.Name = "/unexpected-container-name";
        if (drift === "label") inspected.Config.Labels["ia4tube.social3a0p.run"] = "unexpected-label";
        return result(JSON.stringify(inspected));
      }
      if (args[0] === "ps") {
        const exactInventory = args.includes(`name=^/${names.container}$`);
        const labelOnlyInventory = args.includes(`label=${names.label}`) && !exactInventory;
        if (exactInventory) return result();
        if (labelOnlyInventory) return result(drift === "name" ? `${CONTAINER_ID}\n` : "");
        return result(`${CONTAINER_ID}\n`);
      }
      if (args[0] === "volume" && args[1] === "ls") return result(`${names.volume}\n`);
      if (args[0] === "network" && args[1] === "ls") return result(`${NETWORK_ID}\n`);
      return result();
    }
    const postgres = createLinuxPostgres({
      runnerTemp: root,
      runId,
      PoolClass: FakePool,
      metricsRegistry: metrics(),
      runnerUid: 1001,
      runnerGid: 127,
      runCommand,
      randomBytes: (size) => Buffer.alloc(size, 6)
    });
    try {
      await assert.rejects(postgres.start(), { code: "linux_postgres_container_identity_invalid" });
      cleanupStarted = true;
      await assert.rejects(postgres.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
      await assert.rejects(postgres.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
      const cleanupOnly = createLinuxPostgres({
        runnerTemp: root,
        runId,
        PoolClass: FakePool,
        metricsRegistry: metrics(),
        runnerUid: 1001,
        runnerGid: 127,
        runCommand,
        randomBytes: (size) => Buffer.alloc(size, 8)
      });
      await assert.rejects(cleanupOnly.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
      const cleanupCalls = calls.filter((call) => call.cleanupStarted && call.executable === "docker");
      assert.equal(cleanupCalls.some((call) => call.args[0] === "rm"), false);
      assert.equal(cleanupCalls.some((call) => call.args[0] === "run"), false);
      assert.equal(cleanupCalls.some((call) => call.args[0] === "volume" && call.args[1] === "rm"), false);
      assert.equal(cleanupCalls.some((call) => call.args[0] === "network" && call.args[1] === "rm"), false);
      assert.equal(fs.existsSync(postgres.runRoot), true);
      assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".identity")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("cleanup refuses volume or network label, name, and captured network ID drift without false zero", async () => {
  const replacementNetworkId = "c".repeat(64);
  for (const scenario of [
    { name: "volume-label", volumeLabel: "", volumeName: "expected", networkLabel: NETWORK_ID, networkName: NETWORK_ID },
    { name: "volume-name", volumeLabel: "unexpected-volume", volumeName: "", networkLabel: NETWORK_ID, networkName: NETWORK_ID },
    { name: "network-label", volumeLabel: "expected", volumeName: "expected", networkLabel: "", networkName: NETWORK_ID },
    { name: "network-name", volumeLabel: "expected", volumeName: "expected", networkLabel: NETWORK_ID, networkName: "" },
    { name: "network-id", volumeLabel: "expected", volumeName: "expected", networkLabel: replacementNetworkId, networkName: replacementNetworkId }
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ia4tube-linux-pg-resource-${scenario.name}-`));
    const runId = `linux-resource-${scenario.name}`;
    const names = dockerNames(runId);
    const calls = [];
    let cleanupStarted = false;
    const inventoryValue = (value) => value === "expected" ? names.volume : value;
    async function runCommand(executable, args) {
      calls.push({ executable, args: [...args], cleanupStarted });
      const result = (stdout = "", code = 0) => ({ code, signal: null, stdout, stderr: "" });
      if (executable === "ss") return result();
      if (args[0] === "image" && args[1] === "inspect") {
        return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
      }
      if (args[0] === "network" && args[1] === "create") return result(`${NETWORK_ID}\n`);
      if (args[0] === "run" && args.includes("--detach")) return result(`${CONTAINER_ID}\n`);
      if (args[0] === "network" && args[1] === "inspect") {
        return result(JSON.stringify(networkInspection(names)));
      }
      if (args[0] === "inspect" && args.includes("--type=container")) {
        return result(JSON.stringify(containerInspection(names)));
      }
      if (args[0] === "ps" && args.includes("--format")) {
        return result(`${JSON.stringify({ ID: CONTAINER_ID, Names: names.container, Networks: names.network, Ports: "5432/tcp" })}\n`);
      }
      if (args[0] === "ps") return result(`${CONTAINER_ID}\n`);
      if (args[0] === "volume" && args[1] === "ls") {
        const byLabel = args.includes(`label=${names.label}`);
        const value = byLabel ? scenario.volumeLabel : scenario.volumeName;
        return result(value === "" ? "" : `${inventoryValue(value)}\n`);
      }
      if (args[0] === "network" && args[1] === "ls") {
        const byLabel = args.includes(`label=${names.label}`);
        const value = byLabel ? scenario.networkLabel : scenario.networkName;
        return result(value === "" ? "" : `${value}\n`);
      }
      return result();
    }
    const postgres = createLinuxPostgres({
      runnerTemp: root,
      runId,
      PoolClass: FakePool,
      metricsRegistry: metrics(),
      runnerUid: 1001,
      runnerGid: 127,
      runCommand,
      randomBytes: (size) => Buffer.alloc(size, 6)
    });
    try {
      await postgres.start();
      const markerName = fs.readdirSync(root).find((name) => name.endsWith(".identity"));
      assert.ok(markerName);
      const markerValue = fs.readFileSync(path.join(root, markerName), "ascii");
      assert.match(markerValue, new RegExp(
        "^format=ia4tube-social-3a0p-resource-identity-v1\\n" +
        "networkSha256=[0-9a-f]{64}\\n" +
        "containerState=present\\n" +
        "containerSha256=[0-9a-f]{64}\\n" +
        "volumeSha256=[0-9a-f]{64}\\n$"
      ));
      assert.equal(markerValue.includes(CONTAINER_ID), false);
      assert.equal(markerValue.includes(NETWORK_ID), false);

      cleanupStarted = true;
      await assert.rejects(postgres.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
      const cleanupOnly = createLinuxPostgres({
        runnerTemp: root,
        runId,
        PoolClass: FakePool,
        metricsRegistry: metrics(),
        runnerUid: 1001,
        runnerGid: 127,
        runCommand,
        randomBytes: (size) => Buffer.alloc(size, 8)
      });
      await assert.rejects(cleanupOnly.cleanup(), { code: "linux_postgres_cleanup_incomplete" });

      const cleanupCalls = calls.filter((call) => call.cleanupStarted && call.executable === "docker");
      assert.equal(cleanupCalls.some((call) => call.args[0] === "rm"), false);
      assert.equal(cleanupCalls.some((call) => call.args[0] === "run"), false);
      assert.equal(cleanupCalls.some((call) => call.args[0] === "volume" && call.args[1] === "rm"), false);
      assert.equal(cleanupCalls.some((call) => call.args[0] === "network" && call.args[1] === "rm"), false);
      assert.ok(cleanupCalls.some((call) => call.args[0] === "volume" && call.args.includes(`label=${names.label}`)));
      assert.ok(cleanupCalls.some((call) => call.args[0] === "volume" && call.args.includes(`name=^${names.volume}$`)));
      assert.ok(cleanupCalls.some((call) => call.args[0] === "network" && call.args.includes(`label=${names.label}`) && !call.args.some((arg) => arg.startsWith("name="))));
      assert.ok(cleanupCalls.some((call) => call.args[0] === "network" && call.args.includes(`name=^${names.network}$`)));
      assert.equal(fs.existsSync(postgres.runRoot), true);
      assert.equal(fs.existsSync(path.join(root, markerName)), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("phased identity marker permits exact cross-process cleanup at every pre-container-hash interruption", async () => {
  for (const stage of ["after-network", "after-volume", "after-container-before-hash"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ia4tube-linux-pg-phased-${stage}-`));
    const runId = `linux-phased-${stage}`;
    const names = dockerNames(runId);
    let containerPresent = false;
    let volumePresent = false;
    let networkPresent = false;
    const calls = [];
    const result = (stdout = "", code = 0) => ({ code, signal: null, stdout, stderr: "" });
    async function runCommand(executable, args) {
      calls.push({ executable, args: [...args] });
      if (executable === "ss") return result();
      if (args[0] === "image" && args[1] === "inspect") {
        return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
      }
      if (args[0] === "network" && args[1] === "create") {
        networkPresent = true;
        return result(`${NETWORK_ID}\n`);
      }
      if (args[0] === "volume" && args[1] === "create") {
        if (stage === "after-network") throw new Error("synthetic interruption");
        volumePresent = true;
        return result();
      }
      if (args[0] === "run" && args.includes("--detach")) {
        if (stage === "after-volume") return result("", 1);
        containerPresent = true;
        return result("invalid-container-id\n");
      }
      if (args[0] === "ps") {
        const byLabel = args.includes(`label=${names.label}`);
        const byName = args.includes(`name=^/${names.container}$`);
        if (byLabel || byName || (!args.includes("--filter") && args.includes("--all"))) {
          return result(containerPresent ? `${CONTAINER_ID}\n` : "");
        }
      }
      if (args[0] === "volume" && args[1] === "ls") {
        return result(volumePresent ? `${names.volume}\n` : "");
      }
      if (args[0] === "network" && args[1] === "ls") {
        return result(networkPresent ? `${NETWORK_ID}\n` : "");
      }
      if (args[0] === "rm") {
        assert.equal(args.at(-1), CONTAINER_ID);
        containerPresent = false;
        return result();
      }
      if (args[0] === "volume" && args[1] === "rm") {
        assert.equal(args.at(-1), names.volume);
        volumePresent = false;
        return result();
      }
      if (args[0] === "network" && args[1] === "rm") {
        assert.equal(args.at(-1), NETWORK_ID);
        networkPresent = false;
        return result();
      }
      return result();
    }
    const options = {
      runnerTemp: root,
      runId,
      PoolClass: FakePool,
      metricsRegistry: metrics(),
      runnerUid: 1001,
      runnerGid: 127,
      runCommand,
      randomBytes: (size) => Buffer.alloc(size, 7)
    };
    const interrupted = createLinuxPostgres(options);
    try {
      await assert.rejects(interrupted.start());
      const markerName = fs.readdirSync(root).find((name) => name.endsWith(".identity"));
      assert.ok(markerName);
      const markerPath = path.join(root, markerName);
      const markerStats = fs.lstatSync(markerPath);
      assert.equal(markerStats.isFile(), true);
      assert.equal(markerStats.isSymbolicLink(), false);
      assert.equal(markerStats.nlink, 1);
      if (process.platform === "linux") assert.equal(markerStats.mode & 0o777, 0o600);
      const markerValue = fs.readFileSync(markerPath, "ascii");
      assert.equal(markerValue, [
        "format=ia4tube-social-3a0p-resource-identity-v1",
        `networkSha256=${crypto.createHash("sha256").update(NETWORK_ID, "ascii").digest("hex")}`,
        "containerState=pending",
        `containerSha256=${"0".repeat(64)}`,
        `volumeSha256=${crypto.createHash("sha256").update(names.volume, "ascii").digest("hex")}`,
        ""
      ].join("\n"));
      assert.equal(markerValue.includes(NETWORK_ID), false);
      assert.equal(markerValue.includes(CONTAINER_ID), false);

      const cleanupOnly = createLinuxPostgres({
        ...options,
        metricsRegistry: metrics(),
        randomBytes: (size) => Buffer.alloc(size, 8)
      });
      const cleanup = await cleanupOnly.cleanup();
      assert.equal(cleanup.cleanupCompleted, true);
      assert.equal(cleanup.containerResiduals, 0);
      assert.equal(cleanup.volumeResiduals, 0);
      assert.equal(cleanup.networkResiduals, 0);
      assert.equal(cleanup.temporaryRootResiduals, 0);
      assert.equal(containerPresent, false);
      assert.equal(volumePresent, false);
      assert.equal(networkPresent, false);
      assert.equal(fs.existsSync(interrupted.runRoot), false);
      assert.equal(fs.existsSync(markerPath), false);
      if (stage === "after-container-before-hash") {
        assert.ok(calls.some((call) => call.executable === "docker" && call.args[0] === "rm" && call.args.at(-1) === CONTAINER_ID));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("pending marker cleanup remains fail-closed on container and network identity drift", async () => {
  for (const drift of ["container-name", "container-label", "network-id"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ia4tube-linux-pg-pending-drift-${drift}-`));
    const runId = `linux-pending-drift-${drift}`;
    const names = dockerNames(runId);
    const replacementNetworkId = "c".repeat(64);
    let cleanupStarted = false;
    const calls = [];
    const result = (stdout = "", code = 0) => ({ code, signal: null, stdout, stderr: "" });
    async function runCommand(executable, args) {
      calls.push({ executable, args: [...args], cleanupStarted });
      if (executable === "ss") return result();
      if (args[0] === "image" && args[1] === "inspect") {
        return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
      }
      if (args[0] === "network" && args[1] === "create") return result(`${NETWORK_ID}\n`);
      if (args[0] === "run" && args.includes("--detach")) return result("invalid-container-id\n");
      if (args[0] === "ps") {
        const byLabel = args.includes(`label=${names.label}`);
        const byName = args.includes(`name=^/${names.container}$`);
        if (byLabel) return result(drift === "container-label" ? "" : `${CONTAINER_ID}\n`);
        if (byName) return result(drift === "container-name" ? "" : `${CONTAINER_ID}\n`);
        return result(`${CONTAINER_ID}\n`);
      }
      if (args[0] === "volume" && args[1] === "ls") return result(`${names.volume}\n`);
      if (args[0] === "network" && args[1] === "ls") {
        const id = drift === "network-id" ? replacementNetworkId : NETWORK_ID;
        return result(`${id}\n`);
      }
      return result();
    }
    const options = {
      runnerTemp: root,
      runId,
      PoolClass: FakePool,
      metricsRegistry: metrics(),
      runnerUid: 1001,
      runnerGid: 127,
      runCommand,
      randomBytes: (size) => Buffer.alloc(size, 9)
    };
    const interrupted = createLinuxPostgres(options);
    try {
      await assert.rejects(interrupted.start(), { code: "linux_postgres_container_id_invalid" });
      const markerName = fs.readdirSync(root).find((name) => name.endsWith(".identity"));
      assert.ok(markerName);
      cleanupStarted = true;
      const cleanupOnly = createLinuxPostgres({ ...options, metricsRegistry: metrics() });
      await assert.rejects(cleanupOnly.cleanup(), { code: "linux_postgres_cleanup_incomplete" });
      const destructive = calls.filter((call) => call.cleanupStarted && call.executable === "docker");
      assert.equal(destructive.some((call) => call.args[0] === "rm"), false);
      assert.equal(destructive.some((call) => call.args[0] === "run"), false);
      assert.equal(destructive.some((call) => call.args[0] === "volume" && call.args[1] === "rm"), false);
      assert.equal(destructive.some((call) => call.args[0] === "network" && call.args[1] === "rm"), false);
      assert.equal(fs.existsSync(interrupted.runRoot), true);
      assert.equal(fs.existsSync(path.join(root, markerName)), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    if (executable === "ss") return result();
    if (args[0] === "image" && args[1] === "inspect") {
      return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
    }
    if (args[0] === "network" && args[1] === "create") {
      networkPresent = true;
      return result(`${NETWORK_ID}\n`);
    }
    if (args[0] === "volume" && args[1] === "create") volumePresent = true;
    if (args[0] === "run" && args.includes("--detach")) {
      containerPresent = true;
      return result(`${CONTAINER_ID}\n`);
    }
    if (args[0] === "inspect" && args.includes("--type=container")) {
      return result(JSON.stringify(containerInspection(names)));
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return result(JSON.stringify(networkInspection(names)));
    }
    if (args[0] === "ps" && args.includes("--format")) {
      return result(containerPresent ? `${JSON.stringify({ ID: CONTAINER_ID, Names: names.container, Networks: names.network, Ports: "5432/tcp" })}\n` : "");
    }
    if (args[0] === "ps") return result(containerPresent ? `${CONTAINER_ID}\n` : "");
    if (args[0] === "volume" && args[1] === "ls") return result(volumePresent ? `${names.volume}\n` : "");
    if (args[0] === "network" && args[1] === "ls") return result(networkPresent ? `${NETWORK_ID}\n` : "");
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
      PGPORT: "5432",
      PGDATABASE: "ia4tube_social_local",
      PGUSER: "ia4tube_social_local_migration",
      PGPASSWORD: password
    },
    input: "SELECT 1;"
  });
  const call = calls.at(-1);
  assert.deepEqual(call.args.slice(0, 4), ["exec", "--interactive", "--user", "1001:127"]);
  assert.ok(call.args.includes(CONTAINER_ID));
  assert.ok(call.args.indexOf(CONTAINER_ID) < call.args.indexOf("psql"));
  assert.ok(call.args.includes("PGPASSWORD"));
  assert.equal(call.args.some((argument) => argument.includes(password)), false);
  assert.equal(call.environment.PGPASSWORD, password);
  assert.equal(call.environment.PGHOST, "127.0.0.1");
  assert.equal(call.environment.PGPORT, "5432");
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
