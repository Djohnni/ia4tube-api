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
  inspectContainerBinding,
  safeRunId
} = require("../scripts/social-3a0p-linux-postgres");

const CONTAINER_ID = "a".repeat(64);

function containerInspection(names, overrides = {}) {
  const networkBinding = [{ HostIp: "127.0.0.1", HostPort: "49152" }];
  const configuredBinding = [{ HostIp: "127.0.0.1", HostPort: "49152" }];
  const base = {
    Id: CONTAINER_ID,
    Name: `/${names.container}`,
    Config: { Labels: { "ia4tube.social3a0p.run": names.suffix } },
    State: { Running: true, Paused: false },
    HostConfig: {
      Privileged: false,
      NetworkMode: names.network,
      PortBindings: { "5432/tcp": configuredBinding }
    },
    NetworkSettings: { Ports: { "5432/tcp": networkBinding } }
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

test("host listener probe permits zero rows and refuses external or multiple rows", () => {
  const exact = "LISTEN 0 4096 127.0.0.1:49152 0.0.0.0:*";
  assert.equal(classifyHostListenerRows([], 49152), "none_observed");
  assert.equal(classifyHostListenerRows([exact], 49152), "loopback_ipv4_observed");
  for (const rows of [
    [exact, exact],
    ["LISTEN 0 4096 0.0.0.0:49152 0.0.0.0:*"],
    ["LISTEN 0 4096 [::1]:49152 [::]:*"],
    ["LISTEN 0 4096 *:49152 *:*"]
  ]) {
    assert.throws(() => classifyHostListenerRows(rows, 49152), {
      code: "linux_postgres_listener_exposure_invalid"
    });
  }
});

test("single structured container inspection accepts only the exact owned loopback binding", () => {
  const names = dockerNames("linux-424242");
  const valid = inspectContainerBinding(JSON.stringify(containerInspection(names)), {
    containerId: CONTAINER_ID,
    names,
    diagnostic: { dockerRunCompleted: true, containerIdPresent: true }
  });
  assert.equal(valid.port, 49152);
  assert.equal(valid.diagnostic.containerIdMatched, true);
  assert.equal(valid.diagnostic.containerRunning, true);
  assert.equal(valid.diagnostic.hostIpClass, "loopback_ipv4");
  assert.equal(valid.diagnostic.externalBindingDetected, false);

  const blankHostPort = containerInspection(names);
  blankHostPort.HostConfig.PortBindings["5432/tcp"][0].HostPort = "";
  assert.equal(inspectContainerBinding(JSON.stringify(blankHostPort), {
    containerId: CONTAINER_ID,
    names
  }).port, 49152);

  const unboundAdditionalPort = containerInspection(names);
  unboundAdditionalPort.NetworkSettings.Ports["5433/tcp"] = null;
  unboundAdditionalPort.HostConfig.PortBindings["5433/tcp"] = [];
  assert.throws(() => inspectContainerBinding(JSON.stringify(unboundAdditionalPort), {
    containerId: CONTAINER_ID,
    names
  }), { code: "linux_postgres_port_binding_invalid" });

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
    [changed((v) => { delete v.NetworkSettings.Ports; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { delete v.NetworkSettings.Ports["5432/tcp"]; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"] = null; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"] = []; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"].push({ HostIp: "127.0.0.1", HostPort: "49153" }); }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"][0].HostIp = "::"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"][0].HostIp = "::1"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"][0].HostIp = "192.168.1.8"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"][0].HostIp = "10.8.0.4"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { delete v.NetworkSettings.Ports["5432/tcp"][0].HostPort; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"][0].HostPort = "port"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"][0].HostPort = "80"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5432/tcp"][0].HostPort = "65536"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports["5433/tcp"] = v.NetworkSettings.Ports["5432/tcp"]; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.NetworkSettings.Ports = { "5433/tcp": v.NetworkSettings.Ports["5432/tcp"] }; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.HostConfig.PortBindings["5432/tcp"][0].HostIp = "0.0.0.0"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.HostConfig.PortBindings["5432/tcp"][0].HostPort = "49153"; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { delete v.HostConfig.PortBindings["5432/tcp"]; }), "linux_postgres_port_binding_invalid"],
    [changed((v) => { v.HostConfig.PortBindings["5433/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "49153" }]; }), "linux_postgres_port_binding_invalid"]
  ];
  for (const [stdout, code] of cases) {
    assert.throws(
      () => inspectContainerBinding(stdout, { containerId: CONTAINER_ID, names }),
      { code }
    );
  }
});

test("container inspection failures expose only the closed sanitized diagnostic API", () => {
  const names = dockerNames("linux-434343");
  const unsafe = containerInspection(names);
  unsafe.NetworkSettings.Ports["5432/tcp"][0] = {
    HostIp: "203.0.113.9",
    HostPort: "not-a-port",
    secret: "must-not-appear"
  };
  let observed;
  try {
    inspectContainerBinding(JSON.stringify(unsafe), { containerId: CONTAINER_ID, names });
  } catch (error) {
    observed = error;
  }
  assert.equal(observed.code, "linux_postgres_port_binding_invalid");
  assert.deepEqual(Object.keys(observed.linuxPostgresDiagnostic).sort(), [
    "dockerRunCompleted", "containerIdPresent", "containerIdMatched",
    "containerRunning", "inspectCompleted", "networkSettingsPortsPresent",
    "internalPortEntryPresent", "bindingCount", "hostIpClass",
    "hostPortPresent", "hostPortNumeric", "externalBindingDetected",
    "loopbackConnectionPassed", "failureStage", "exitCodeClass",
    "signalPresent", "stdoutPresent", "stderrPresent"
  ].sort());
  assert.equal(JSON.stringify(observed).includes("must-not-appear"), false);
  assert.equal(observed.linuxPostgresDiagnostic.hostIpClass, "other");

  let absent;
  try {
    inspectContainerBinding(JSON.stringify(containerInspection(names, {
      NetworkSettings: { Ports: {} }
    })), { containerId: CONTAINER_ID, names });
  } catch (error) {
    absent = error;
  }
  assert.equal(absent.linuxPostgresDiagnostic.internalPortEntryPresent, false);
  assert.equal(absent.linuxPostgresDiagnostic.externalBindingDetected, false);
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
    if (args[0] === "network" && args[1] === "create") networkPresent = true;
    if (args[0] === "volume" && args[1] === "create") volumePresent = true;
    if (args[0] === "run" && args.includes("--detach")) {
      containerPresent = true;
      return result(`${CONTAINER_ID}\n`);
    }
    if (args[0] === "inspect" && args.includes("--type=container")) {
      return result(JSON.stringify(containerInspection(names)));
    }
    if (args[0] === "ps") return result(containerPresent ? `${CONTAINER_ID}\n` : "");
    if (args[0] === "volume" && args[1] === "ls") return result(volumePresent ? `${names.volume}\n` : "");
    if (args[0] === "network" && args[1] === "ls") return result(networkPresent ? "network-id\n" : "");
    if (args[0] === "rm") {
      if (failContainerRemoval) return result("", 1);
      containerPresent = false;
    }
    if (args[0] === "volume" && args[1] === "rm") volumePresent = false;
    if (args[0] === "network" && args[1] === "rm") networkPresent = false;
    return result();
  }
  class OrderedPool extends FakePool {
    async query(...args) {
      calls.push({ executable: "pool", args: ["query"], environment: {} });
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
    assert.equal(result.port, 49152);
    assert.equal(result.containerIdCaptured, true);
    assert.equal(result.containerIdMatched, true);
    assert.equal(result.structuredInspectCompleted, true);
    assert.equal(result.hostIp, "127.0.0.1");
    assert.equal(result.hostPort, 49152);
    assert.equal(result.bindingCount, 1);
    assert.equal(result.loopbackConnectionPassed, true);
    assert.equal(result.hostListener, "none_observed");
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
    assert.equal(calls.some((call) => call.args[0] === "port"), false);
    const containerInspect = calls.find((call) => call.args[0] === "inspect" && call.args.includes("--type=container"));
    assert.deepEqual(containerInspect.args, [
      "inspect", "--type=container", "--format", "{{json .}}", CONTAINER_ID
    ]);
    assert.ok(calls.findIndex((call) => call.args[0] === "exec") < calls.indexOf(containerInspect));
    assert.ok(calls.indexOf(containerInspect) < calls.findIndex((call) => call.executable === "pool"));
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

test("missing or invalid container id, failed inspect and loopback failure stay sanitized and clean", async () => {
  for (const scenario of [
    { runStdout: "", idPresent: false, inspectCode: 0, exitClass: "zero", code: "linux_postgres_container_id_invalid", stage: "container_id" },
    { runStdout: "\n", idPresent: false, inspectCode: 0, exitClass: "zero", code: "linux_postgres_container_id_invalid", stage: "container_id" },
    { runStdout: "abc\n", idPresent: true, inspectCode: 0, exitClass: "zero", code: "linux_postgres_container_id_invalid", stage: "container_id" },
    { runStdout: ` ${CONTAINER_ID}\n`, idPresent: true, inspectCode: 0, exitClass: "zero", code: "linux_postgres_container_id_invalid", stage: "container_id" },
    { runStdout: `${CONTAINER_ID}\n`, idPresent: true, readinessFails: true, exitClass: "nonzero", stderrPresent: true, code: "linux_postgres_readiness_failed", stage: "readiness" },
    { runStdout: `${CONTAINER_ID}\n`, idPresent: true, inspectCode: 1, exitClass: "nonzero", stderrPresent: true, code: "linux_postgres_container_inspect_failed", stage: "container_inspect" },
    { runStdout: `${CONTAINER_ID}\n`, idPresent: true, inspectCode: 0, exitClass: "not_observed", poolFails: true, code: "linux_postgres_loopback_connection_failed", stage: "loopback_connection" }
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-failure-"));
    const names = dockerNames("linux-515151");
    let containerPresent = false;
    let volumePresent = false;
    let networkPresent = false;
    const calls = [];
    async function runCommand(executable, args) {
      calls.push([...args]);
      const result = (stdout = "", code = 0, stderr = "") => ({ code, signal: null, stdout, stderr });
      if (executable === "ss") return result();
      if (args[0] === "image" && args[1] === "inspect") {
        return result(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`postgres@${IMAGE_DIGEST}`] }));
      }
      if (args[0] === "network" && args[1] === "create") networkPresent = true;
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
      if (args[0] === "ps") return result(containerPresent ? `${CONTAINER_ID}\n` : "");
      if (args[0] === "volume" && args[1] === "ls") return result(volumePresent ? `${names.volume}\n` : "");
      if (args[0] === "network" && args[1] === "ls") return result(networkPresent ? `${names.network}\n` : "");
      if (args[0] === "rm") containerPresent = false;
      if (args[0] === "volume" && args[1] === "rm") volumePresent = false;
      if (args[0] === "network" && args[1] === "rm") networkPresent = false;
      return result();
    }
    class ScenarioPool extends FakePool {
      async query(...args) {
        if (scenario.poolFails) throw new Error("synthetic connection failure");
        return super.query(...args);
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
      assert.equal(observed.linuxPostgresDiagnostic.dockerRunCompleted, true);
      assert.equal(observed.linuxPostgresDiagnostic.containerIdPresent, scenario.idPresent);
      assert.equal(observed.linuxPostgresDiagnostic.exitCodeClass, scenario.exitClass);
      assert.equal(observed.linuxPostgresDiagnostic.stderrPresent, scenario.stderrPresent === true);
      assert.equal(observed.linuxPostgresDiagnostic.loopbackConnectionPassed, false);
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
    if (args[0] === "run" && args.includes("--detach")) return result(`${CONTAINER_ID}\n`);
    if (args[0] === "inspect" && args.includes("--type=container")) {
      return result(JSON.stringify(containerInspection(names)));
    }
    if (args[0] === "ps") return result(cleanupStarted ? `${discoveredId}\n` : `${CONTAINER_ID}\n`);
    if (args[0] === "volume" && args[1] === "ls") return result(`${names.volume}\n`);
    if (args[0] === "network" && args[1] === "ls") return result("network-id\n");
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
      if (args[0] === "run" && args.includes("--detach")) return result(`${CONTAINER_ID}\n`);
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
      if (args[0] === "network" && args[1] === "ls") return result("network-id\n");
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
    if (args[0] === "run" && args.includes("--detach")) {
      containerPresent = true;
      return result(`${CONTAINER_ID}\n`);
    }
    if (args[0] === "inspect" && args.includes("--type=container")) {
      const inspected = containerInspection(names);
      inspected.NetworkSettings.Ports["5432/tcp"][0].HostPort = "49153";
      inspected.HostConfig.PortBindings["5432/tcp"][0].HostPort = "49153";
      return result(JSON.stringify(inspected));
    }
    if (args[0] === "ps") return result(containerPresent ? `${CONTAINER_ID}\n` : "");
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
  assert.ok(call.args.includes(CONTAINER_ID));
  assert.ok(call.args.indexOf(CONTAINER_ID) < call.args.indexOf("psql"));
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
