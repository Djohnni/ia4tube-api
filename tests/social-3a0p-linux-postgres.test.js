"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  DATABASE,
  IMAGE,
  IMAGE_DIGEST,
  classifyHostListenerRows,
  createLinuxPostgres,
  dockerNames,
  generatedSecret,
  inspectContainerListing,
  inspectInternalContainer,
  inspectInternalNetwork,
  instrumentedPoolClass,
  MIGRATION_LOGIN,
  OWNER_ROLE,
  POSTGRES_CONNECTIVITY_MODE,
  PROVISIONER_LOGIN,
  safeRunId
} = require("../scripts/social-3a0p-linux-postgres");
const {
  createPoolMetricsRegistry
} = require("../scripts/social-3a0p-local-runtime-evidence-metrics");

const CONTAINER_ID = "a".repeat(64);
const NETWORK_ID = "b".repeat(64);
const PRIVATE_HOST = "172.30.0.2";
const BACKUP_CONNECTIVITY_MODE = "logical_dns_to_internal_container_v1";
const BACKUP_LOGICAL_HOST = "backup.local.ia4tube.invalid";
const BACKUP_PHYSICAL_MODE = "internal_container_loopback";
const BACKUP_APPLICATION_NAME = "ia4tube-social-backup-restore";
const BACKUP_RUN_ID = "linux-backup-transport-271828";
const BACKUP_RUN_MARKER = `ia4tube-social-3a0p-linux-${crypto
  .createHash("sha256")
  .update(BACKUP_RUN_ID)
  .digest("hex")
  .slice(0, 16)}`;

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

class TrackedPoolSet extends Set {
  constructor(events = []) {
    super();
    this.events = events;
    this.addCalls = 0;
    this.deleteCalls = 0;
  }

  add(pool) {
    this.addCalls += 1;
    this.events.push({ type: "tracked-add", pool });
    return super.add(pool);
  }

  delete(pool) {
    this.deleteCalls += 1;
    this.events.push({ type: "tracked-delete", pool });
    return super.delete(pool);
  }
}

test("pool metrics lifecycle observes active and draining events, then detaches exact callbacks once", async () => {
  const events = [];
  const trackedPools = new TrackedPoolSet(events);
  let registered = false;
  let finishBaseEnd;
  const registry = {
    register(pool) {
      assert.equal(registered, false);
      registered = true;
      events.push({ type: "register", pool });
    },
    observe(pool) {
      assert.equal(registered, true);
      events.push({
        type: "observe",
        state: pool.linuxMetricsLifecycle.state,
        total: pool.totalCount
      });
    },
    recordAcquisition(pool) {
      assert.equal(registered, true);
      events.push({ type: "acquire", state: pool.linuxMetricsLifecycle.state });
    },
    unregister(pool) {
      assert.equal(registered, true);
      assert.equal(pool.listenerCount("connect"), 0);
      assert.equal(pool.listenerCount("acquire"), 0);
      assert.equal(pool.listenerCount("remove"), 0);
      events.push({ type: "unregister", state: pool.linuxMetricsLifecycle.state });
      registered = false;
    }
  };
  class ControlledPool extends FakePool {
    end() {
      this.baseEndCalls = (this.baseEndCalls || 0) + 1;
      events.push({ type: "super-end", state: this.linuxMetricsLifecycle.state });
      return new Promise((resolve) => { finishBaseEnd = resolve; });
    }

    off(eventName, callback) {
      events.push({
        type: `off-${eventName}`,
        exact: callback === this.linuxMetricsLifecycle.callbacks[eventName],
        state: this.linuxMetricsLifecycle.state
      });
      return super.off(eventName, callback);
    }
  }
  const InstrumentedPool = instrumentedPoolClass(ControlledPool, registry, trackedPools);
  const pool = new InstrumentedPool({ max: 3, application_name: "lifecycle-runtime" });
  const callbacks = pool.linuxMetricsLifecycle.callbacks;

  assert.equal(pool.linuxMetricsLifecycle.state, "active");
  assert.strictEqual(pool.listeners("connect")[0], callbacks.connect);
  assert.strictEqual(pool.listeners("acquire")[0], callbacks.acquire);
  assert.strictEqual(pool.listeners("remove")[0], callbacks.remove);
  assert.equal(events.filter((event) => event.type === "observe").length, 1);
  assert.equal(events.filter((event) => event.type === "acquire").length, 0);
  pool.totalCount = 1;
  pool.emit("connect");
  assert.equal(events.filter((event) => event.type === "observe").length, 2);
  pool.emit("acquire");
  assert.equal(events.filter((event) => event.type === "acquire").length, 1);
  pool.emit("remove");
  assert.equal(events.filter((event) => event.type === "observe").length, 3);

  const firstEnd = pool.end();
  const concurrentEnd = pool.end();
  assert.strictEqual(concurrentEnd, firstEnd);
  assert.equal(pool.linuxMetricsLifecycle.state, "draining");
  await Promise.resolve();
  assert.equal(pool.baseEndCalls, 1);
  pool.totalCount = 2;
  pool.emit("remove");
  assert.equal(events.filter((event) => event.type === "observe").length, 4);
  assert.equal(events.filter((event) => event.type === "observe").at(-1).state, "draining");
  pool.totalCount = 0;
  finishBaseEnd("base-ended");
  assert.equal(await firstEnd, "base-ended");

  assert.equal(pool.linuxMetricsLifecycle.state, "closed");
  assert.equal(trackedPools.addCalls, 1);
  assert.equal(trackedPools.deleteCalls, 1);
  assert.equal(trackedPools.size, 0);
  assert.equal(events.filter((event) => event.type === "unregister").length, 1);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("off-")).map((event) => [event.type, event.exact, event.state]),
    [
      ["off-connect", true, "detached"],
      ["off-acquire", true, "detached"],
      ["off-remove", true, "detached"]
    ]
  );
  const finalObserveIndex = events.findLastIndex((event) => event.type === "observe");
  const firstOffIndex = events.findIndex((event) => event.type === "off-connect");
  const unregisterIndex = events.findIndex((event) => event.type === "unregister");
  const trackedDeleteIndex = events.findIndex((event) => event.type === "tracked-delete");
  assert.equal(events[finalObserveIndex].state, "draining");
  assert.equal(events[finalObserveIndex].total, 0);
  assert.ok(finalObserveIndex < firstOffIndex);
  assert.ok(firstOffIndex < unregisterIndex);
  assert.ok(unregisterIndex < trackedDeleteIndex);

  const metricCallsBeforeLateCallbacks = events.filter((event) => (
    event.type === "observe" || event.type === "acquire"
  )).length;
  assert.doesNotThrow(() => callbacks.remove());
  assert.doesNotThrow(() => callbacks.connect());
  assert.doesNotThrow(() => callbacks.acquire());
  assert.equal(events.filter((event) => (
    event.type === "observe" || event.type === "acquire"
  )).length, metricCallsBeforeLateCallbacks);
  assert.strictEqual(pool.end(), firstEnd);
  assert.equal(pool.baseEndCalls, 1);
  assert.equal(trackedPools.deleteCalls, 1);
});

test("callback pool end waits for its callback, shares one close, and reports completion after detach", async () => {
  const events = [];
  const uncaught = [];
  const unhandled = [];
  const onUncaught = (error) => { uncaught.push(error); };
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    let finishBaseEnd;
    let registered = false;
    const trackedPools = new TrackedPoolSet(events);
    const registry = {
      register() { registered = true; },
      observe(pool) {
        assert.equal(registered, true);
        events.push({ type: "observe", state: pool.linuxMetricsLifecycle.state });
      },
      recordAcquisition() {},
      unregister(pool) {
        assert.equal(pool.linuxMetricsLifecycle.state, "detached");
        registered = false;
        events.push({ type: "unregister" });
      }
    };
    class CallbackPool extends FakePool {
      end(callback) {
        this.baseEndCalls = (this.baseEndCalls || 0) + 1;
        this.emit("remove");
        finishBaseEnd = () => callback(null, "callback-ended");
        return undefined;
      }
    }
    const InstrumentedPool = instrumentedPoolClass(CallbackPool, registry, trackedPools);
    const pool = new InstrumentedPool({ max: 1, application_name: "administration" });
    const callbackResults = [];
    const firstEnd = pool.end((...callbackArgs) => {
      callbackResults.push({ callbackArgs, state: pool.linuxMetricsLifecycle.state });
    });
    const concurrentEnd = pool.end((...callbackArgs) => {
      callbackResults.push({ callbackArgs, state: pool.linuxMetricsLifecycle.state });
    });
    assert.strictEqual(concurrentEnd, firstEnd);
    await Promise.resolve();
    assert.equal(pool.baseEndCalls, 1);
    assert.equal(pool.linuxMetricsLifecycle.state, "draining");
    assert.equal(events.filter((event) => event.type === "observe").at(-1).state, "draining");
    assert.deepEqual(callbackResults, []);
    finishBaseEnd();
    assert.equal(await firstEnd, "callback-ended");
    assert.deepEqual(callbackResults, [
      { callbackArgs: [null, "callback-ended"], state: "closed" },
      { callbackArgs: [null, "callback-ended"], state: "closed" }
    ]);
    assert.equal(events.filter((event) => event.type === "unregister").length, 1);
    assert.equal(trackedPools.deleteCalls, 1);
    assert.equal(trackedPools.size, 0);
    const postCloseResults = [];
    assert.strictEqual(pool.end((...callbackArgs) => postCloseResults.push(callbackArgs)), firstEnd);
    assert.deepEqual(postCloseResults, [[null, "callback-ended"]]);
    await Promise.resolve();
    assert.deepEqual(uncaught, []);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("callback pool end preserves its base error over final metrics failure", async () => {
  const baseError = new Error("callback_pool_end_failed");
  const finalMetricsError = new Error("callback_final_metrics_failed");
  const trackedPools = new TrackedPoolSet();
  let finishBaseEnd;
  let observeCalls = 0;
  const registry = {
    register() {},
    observe() {
      observeCalls += 1;
      if (observeCalls > 2) throw finalMetricsError;
    },
    recordAcquisition() {},
    unregister() {}
  };
  class CallbackFailingPool extends FakePool {
    end(callback) {
      this.emit("remove");
      finishBaseEnd = () => callback(baseError);
    }
  }
  const InstrumentedPool = instrumentedPoolClass(CallbackFailingPool, registry, trackedPools);
  const pool = new InstrumentedPool({ max: 1, application_name: "administration" });
  let reportedError = null;
  const endPromise = pool.end((error) => { reportedError = error; });
  await Promise.resolve();
  finishBaseEnd();
  await assert.rejects(endPromise, (error) => error === baseError);
  assert.strictEqual(reportedError, baseError);
  assert.equal(pool.linuxMetricsLifecycle.state, "closed");
  assert.equal(trackedPools.deleteCalls, 1);
});

test("callback-only end reports its exact error without an unhandled rejection", async () => {
  const baseError = new Error("callback_only_pool_end_failed");
  const uncaught = [];
  const unhandled = [];
  const onUncaught = (error) => { uncaught.push(error); };
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    let finishBaseEnd;
    class CallbackOnlyPool extends FakePool {
      end(callback) {
        finishBaseEnd = () => callback(baseError);
      }
    }
    const trackedPools = new TrackedPoolSet();
    const InstrumentedPool = instrumentedPoolClass(CallbackOnlyPool, metrics(), trackedPools);
    const pool = new InstrumentedPool({ max: 1, application_name: "administration" });
    let reportedError = null;
    let callbackState = null;
    pool.end((error) => {
      reportedError = error;
      callbackState = pool.linuxMetricsLifecycle.state;
    });
    await Promise.resolve();
    finishBaseEnd();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(reportedError, baseError);
    assert.equal(callbackState, "closed");
    assert.deepEqual(uncaught, []);
    assert.deepEqual(unhandled, []);
    assert.equal(trackedPools.deleteCalls, 1);
    assert.equal(trackedPools.size, 0);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("pool metrics lifecycle preserves the original end failure while completing teardown", async () => {
  const primaryError = new Error("base_pool_end_failed");
  const finalMetricsError = new Error("final_metrics_failed");
  const trackedPools = new TrackedPoolSet();
  let observeCalls = 0;
  let unregisterCalls = 0;
  const registry = {
    register() {},
    observe() {
      observeCalls += 1;
      if (observeCalls > 1) throw finalMetricsError;
    },
    recordAcquisition() {},
    unregister() { unregisterCalls += 1; }
  };
  class FailingPool extends FakePool {
    end() { throw primaryError; }
  }
  const InstrumentedPool = instrumentedPoolClass(FailingPool, registry, trackedPools);
  const pool = new InstrumentedPool({ max: 1, application_name: "administration" });
  const firstEnd = pool.end();
  assert.strictEqual(pool.end(), firstEnd);
  await assert.rejects(firstEnd, (error) => error === primaryError);
  assert.equal(pool.linuxMetricsLifecycle.state, "closed");
  assert.equal(unregisterCalls, 1);
  assert.equal(trackedPools.deleteCalls, 1);
  assert.equal(trackedPools.size, 0);
  assert.equal(pool.listenerCount("connect"), 0);
  assert.equal(pool.listenerCount("acquire"), 0);
  assert.equal(pool.listenerCount("remove"), 0);
});

test("active and final metric failures remain real while teardown still closes the pool", async () => {
  const activeMetricsError = new Error("active_metrics_failed");
  const finalMetricsError = new Error("final_metrics_failed");
  const trackedPools = new TrackedPoolSet();
  let failActive = false;
  let failFinal = false;
  let unregisterCalls = 0;
  const registry = {
    register() {},
    observe(pool) {
      if (pool.linuxMetricsLifecycle.state === "active" && failActive) throw activeMetricsError;
      if (pool.linuxMetricsLifecycle.state === "draining" && failFinal) throw finalMetricsError;
    },
    recordAcquisition() {},
    unregister() { unregisterCalls += 1; }
  };
  const InstrumentedPool = instrumentedPoolClass(FakePool, registry, trackedPools);
  const pool = new InstrumentedPool({ max: 1, application_name: "administration" });
  failActive = true;
  assert.throws(() => pool.emit("connect"), (error) => error === activeMetricsError);
  assert.equal(pool.linuxMetricsLifecycle.state, "active");
  failActive = false;
  failFinal = true;
  await assert.rejects(pool.end(), (error) => error === finalMetricsError);
  assert.equal(pool.linuxMetricsLifecycle.state, "closed");
  assert.equal(unregisterCalls, 1);
  assert.equal(trackedPools.deleteCalls, 1);
});

test("real metrics registry stays fail-closed and retains peaks after pool shutdown", async () => {
  const registry = createPoolMetricsRegistry();
  const trackedPools = new TrackedPoolSet();
  const InstrumentedPool = instrumentedPoolClass(FakePool, registry, trackedPools);
  const pool = new InstrumentedPool({ max: 3, application_name: "lifecycle-runtime" });
  pool.totalCount = 3;
  pool.idleCount = 1;
  pool.waitingCount = 2;
  pool.emit("acquire");
  pool.idleCount = 0;
  pool.waitingCount = 1;
  pool.emit("connect");
  await pool.end();

  const snapshot = registry.snapshot();
  assert.equal(snapshot.counts.poolConfiguredMaxGlobal, 3);
  assert.equal(snapshot.counts.poolAcquisitionsGlobal, 1);
  assert.equal(snapshot.metrics.poolPeakTotalGlobal, 3);
  assert.equal(snapshot.metrics.poolPeakActiveGlobal, 3);
  assert.equal(snapshot.metrics.poolPeakIdleGlobal, 1);
  assert.equal(snapshot.metrics.poolPeakWaitingGlobal, 2);
  assert.equal(snapshot.checks.poolConfiguredMaxRespected, true);
  assert.throws(
    () => registry.observe(pool, pool),
    { code: "harness_pool_metrics_pool_unregistered" }
  );
});

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
      calls.push({ executable: "pool-create", args: [], configuration: { ...configuration }, environment: {}, pool: this });
    }

    async query(...args) {
      calls.push({ executable: "pool", args: ["query", ...args], environment: {} });
      return super.query(...args);
    }

    async end() {
      this.savedRemoveCallback = this.listeners("remove")[0];
      this.emit("remove");
      return super.end();
    }
  }
  const poolMetrics = createPoolMetricsRegistry();
  const postgres = createLinuxPostgres({
    runnerTemp: root,
    runId: "linux-314159",
    PoolClass: OrderedPool,
    metricsRegistry: poolMetrics,
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
    assert.equal(postgres.trackedPoolCount, 0);
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
    assert.equal(directPool.pool.linuxMetricsLifecycle.state, "closed");
    assert.doesNotThrow(() => directPool.pool.savedRemoveCallback());
    assert.throws(
      () => poolMetrics.observe(directPool.pool, directPool.pool),
      { code: "harness_pool_metrics_pool_unregistered" }
    );
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
    assert.equal(postgres.trackedPoolCount, 0);
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

function backupTargetFingerprint(database) {
  return crypto.createHash("sha256").update([
    "ia4tube-social-backup-target-v2",
    BACKUP_LOGICAL_HOST,
    "5432",
    database,
    "tls-verify-full"
  ].join("/")).digest("hex");
}

function exactBackupContract(overrides = {}) {
  const database = overrides.database || DATABASE;
  return {
    database,
    login: MIGRATION_LOGIN,
    runMarker: BACKUP_RUN_MARKER,
    targetFingerprint: backupTargetFingerprint(database),
    ...overrides
  };
}

function disposableBackupDatabase(label = "source_0003") {
  const suffix = crypto.createHash("sha256")
    .update(BACKUP_RUN_MARKER)
    .digest("hex")
    .slice(0, 12);
  return `ia4tube_social_disposable_${label}_${suffix}`;
}

async function createBackupTransportFixture(fixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-backup-transport-"));
  const calls = [];
  let containerPresent = false;
  let volumePresent = false;
  let networkPresent = false;
  let randomFill = 1;
  const names = dockerNames(BACKUP_RUN_ID);
  async function runCommand(executable, args, commandOptions = {}) {
    calls.push({
      executable,
      args: [...args],
      environment: { ...(commandOptions.environment || {}) },
      input: commandOptions.input
    });
    const result = (stdout = "", code = 0, stderr = "") => ({
      code, signal: null, stdout, stderr
    });
    if (executable === "ss") return result();
    if (args[0] === "image" && args[1] === "inspect") {
      return result(JSON.stringify({
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [`postgres@${IMAGE_DIGEST}`]
      }));
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
      return result(containerPresent
        ? `${JSON.stringify({
            ID: CONTAINER_ID,
            Names: names.container,
            Networks: names.network,
            Ports: "5432/tcp"
          })}\n`
        : "");
    }
    if (args[0] === "ps") return result(containerPresent ? `${CONTAINER_ID}\n` : "");
    if (args[0] === "volume" && args[1] === "ls") {
      return result(volumePresent ? `${names.volume}\n` : "");
    }
    if (args[0] === "network" && args[1] === "ls") {
      return result(networkPresent ? `${NETWORK_ID}\n` : "");
    }
    if (args[0] === "exec") {
      const containerIndex = args.indexOf(CONTAINER_ID);
      const tool = containerIndex >= 0 ? args[containerIndex + 1] : "";
      const code = Number(fixtureOptions.toolExitCodes?.[tool] || 0);
      return result("", code, code === 0 ? "" : "synthetic tool failure");
    }
    if (args[0] === "rm") containerPresent = false;
    if (args[0] === "volume" && args[1] === "rm") volumePresent = false;
    if (args[0] === "network" && args[1] === "rm") networkPresent = false;
    return result();
  }
  const postgres = createLinuxPostgres({
    runnerTemp: root,
    runId: BACKUP_RUN_ID,
    PoolClass: FakePool,
    metricsRegistry: metrics(),
    runnerUid: 1001,
    runnerGid: 127,
    runCommand,
    randomBytes(size) {
      const value = Buffer.alloc(size, randomFill);
      randomFill += 1;
      return value;
    }
  });
  await postgres.start();
  return {
    calls,
    names,
    postgres,
    root,
    runTool: postgres.createRunTool(),
    async destroy() {
      try {
        await postgres.cleanup();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  };
}

function exactBackupEnvironment(fixture, binding, overrides = {}) {
  const environment = {
    LANG: "C.UTF-8",
    PGHOST: BACKUP_LOGICAL_HOST,
    PGPORT: "5432",
    PGDATABASE: binding.database,
    PGUSER: binding.login,
    PGPASSWORD: fixture.postgres.materials[
      binding.login === PROVISIONER_LOGIN ? "provisioner" : "migration"
    ].toString("utf8"),
    PGCONNECT_TIMEOUT: "10",
    PGCHANNELBINDING: "disable",
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "system",
    SSL_CERT_FILE: path.join(fixture.postgres.workDirectory, "postgres-system-roots.pem"),
    PGAPPNAME: BACKUP_APPLICATION_NAME,
    ...overrides
  };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name];
  }
  return environment;
}

function exactBackupPlan(fixture, binding, kind = "psql") {
  const environment = exactBackupEnvironment(fixture, binding);
  if (kind === "pg_dump") {
    return {
      executable: "/usr/bin/pg_dump",
      args: [
        "--format=custom", "--compress=9", "--no-password",
        `--role=${OWNER_ROLE}`, "--schema=ia4tube_social",
        "--schema=ia4tube_social_admin", "--schema=ia4tube_migrations",
        "--lock-wait-timeout=10000", "--schema-only",
        `--file=${path.join(fixture.postgres.workDirectory, "backup-schema.dump")}`
      ],
      env: environment
    };
  }
  if (kind === "pg_restore") {
    return {
      executable: "/usr/bin/pg_restore",
      args: [
        "--exit-on-error", "--single-transaction", "--no-password",
        "--no-owner", `--role=${OWNER_ROLE}`,
        `--dbname=${binding.database}`,
        path.join(fixture.postgres.workDirectory, "restore-schema.dump")
      ],
      env: environment
    };
  }
  if (kind === "pg_restore_list") {
    return {
      executable: "/usr/bin/pg_restore",
      args: [
        "--list",
        path.join(fixture.postgres.workDirectory, "offline-schema.dump")
      ],
      env: { LANG: "C.UTF-8" }
    };
  }
  return {
    executable: "/usr/bin/psql",
    args: [
      "--no-password", "--no-psqlrc", "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=terse", "--quiet", "--file=-"
    ],
    env: environment,
    input: "SELECT 1;"
  };
}

function planWithEnvironment(plan, overrides) {
  const environment = { ...plan.env, ...overrides };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name];
  }
  return { ...plan, env: environment };
}

async function rejectsWithoutSecret(operation, code, secret) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(String(error?.message || "").includes(secret), false);
    return true;
  });
}

test("backup transport factory emits only the immutable 11-key logical-to-physical binding", async () => {
  const fixture = await createBackupTransportFixture();
  try {
    const callCount = fixture.calls.length;
    const contract = exactBackupContract();
    assert.deepEqual(Object.keys(contract).sort(), [
      "database", "login", "runMarker", "targetFingerprint"
    ]);
    const binding = fixture.postgres.createBackupTransportBinding(contract);
    assert.equal(Object.isFrozen(binding), true);
    assert.deepEqual(Object.keys(binding).sort(), [
      "connectivityMode", "containerIdentityDigest", "database", "logicalHost",
      "logicalPort", "login", "physicalHost", "physicalMode", "physicalPort",
      "runMarker", "targetFingerprint"
    ]);
    assert.deepEqual(binding, {
      connectivityMode: BACKUP_CONNECTIVITY_MODE,
      logicalHost: BACKUP_LOGICAL_HOST,
      logicalPort: 5432,
      physicalMode: BACKUP_PHYSICAL_MODE,
      physicalHost: "127.0.0.1",
      physicalPort: 5432,
      database: DATABASE,
      login: MIGRATION_LOGIN,
      runMarker: BACKUP_RUN_MARKER,
      targetFingerprint: backupTargetFingerprint(DATABASE),
      containerIdentityDigest: crypto.createHash("sha256")
        .update(CONTAINER_ID, "ascii")
        .digest("hex")
    });
    assert.equal(JSON.stringify(binding).includes(CONTAINER_ID), false);
    assert.equal(JSON.stringify(binding).includes(
      fixture.postgres.materials.migration.toString("utf8")
    ), false);
    assert.throws(() => { binding.logicalHost = "127.0.0.1"; }, TypeError);

    const disposableDatabase = disposableBackupDatabase();
    const disposable = fixture.postgres.createBackupTransportBinding(
      exactBackupContract({ database: disposableDatabase })
    );
    assert.equal(disposable.database, disposableDatabase);
    const provisioner = fixture.postgres.createBackupTransportBinding(
      exactBackupContract({ login: PROVISIONER_LOGIN })
    );
    assert.equal(provisioner.login, PROVISIONER_LOGIN);

    const invalidContracts = [
      null,
      { ...contract, physicalHost: "127.0.0.1" },
      Object.fromEntries(Object.entries(contract).filter(([name]) => name !== "targetFingerprint")),
      exactBackupContract({ database: "ia4tube_social_other" }),
      exactBackupContract({ database: `${disposableDatabase}0` }),
      exactBackupContract({ login: "ia4tube_social_local_runtime" }),
      exactBackupContract({ runMarker: "wrong" }),
      exactBackupContract({
        runMarker: "ia4tube-social-3a0p-another-linux-run-0001"
      }),
      exactBackupContract({ targetFingerprint: "0".repeat(64) }),
      exactBackupContract({ targetFingerprint: "A".repeat(64) })
    ];
    for (const candidate of invalidContracts) {
      assert.throws(
        () => fixture.postgres.createBackupTransportBinding(candidate),
        { code: "linux_postgres_backup_transport_contract_invalid" }
      );
    }
    assert.equal(fixture.calls.length, callCount);
  } finally {
    await fixture.destroy();
  }
});

test("backup transport refuses every forged binding field before docker exec", async () => {
  const fixture = await createBackupTransportFixture();
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const plan = exactBackupPlan(fixture, binding);
    const secret = plan.env.PGPASSWORD;
    const callCount = fixture.calls.length;
    const mutations = [
      { connectivityMode: "logical_dns_to_other_transport_v1" },
      { logicalHost: "127.0.0.1" },
      { logicalHost: "10.20.30.40" },
      { logicalHost: "localhost" },
      { logicalHost: "other.local.ia4tube.invalid" },
      { logicalHost: "social-staging.example.com" },
      { logicalHost: "social.example.com" },
      { logicalPort: 5433 },
      { physicalMode: "host_loopback" },
      { physicalHost: "172.30.0.2" },
      { physicalPort: 5433 },
      { database: "ia4tube_social_other" },
      { login: PROVISIONER_LOGIN },
      { runMarker: "ia4tube-social-3a0p-another-linux-run-0001" },
      { targetFingerprint: "d".repeat(64) },
      { containerIdentityDigest: "e".repeat(64) }
    ];
    for (const mutation of mutations) {
      const forged = Object.freeze({ ...binding, ...mutation });
      await rejectsWithoutSecret(
        () => fixture.runTool(plan, forged),
        "linux_postgres_backup_transport_binding_invalid",
        secret
      );
    }
    const missing = { ...binding };
    delete missing.containerIdentityDigest;
    for (const forged of [
      binding && { ...binding },
      Object.freeze(missing),
      Object.freeze({ ...binding, unexpected: true })
    ]) {
      await rejectsWithoutSecret(
        () => fixture.runTool(plan, forged),
        "linux_postgres_backup_transport_binding_invalid",
        secret
      );
    }
    assert.equal(fixture.calls.length, callCount);
  } finally {
    await fixture.destroy();
  }
});

test("backup transport refuses logical TLS and command divergence before child execution", async () => {
  const fixture = await createBackupTransportFixture();
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const plan = exactBackupPlan(fixture, binding);
    const secret = plan.env.PGPASSWORD;
    const callCount = fixture.calls.length;
    const environmentMutations = [
      { PGHOST: "127.0.0.1" },
      { PGHOST: "10.20.30.40" },
      { PGHOST: "localhost" },
      { PGHOST: "other.local.ia4tube.invalid" },
      { PGHOST: "social-staging.example.com" },
      { PGHOST: "social.example.com" },
      { PGPORT: "5433" },
      { PGDATABASE: "ia4tube_social_other" },
      { PGUSER: PROVISIONER_LOGIN },
      { PGPASSWORD: "synthetic-wrong-password-not-authorized-for-this-login" },
      { PGSSLMODE: "disable" },
      { PGSSLMODE: "require" },
      { PGSSLROOTCERT: undefined },
      { PGSSLROOTCERT: "root.crt" },
      { SSL_CERT_FILE: undefined },
      { SSL_CERT_FILE: path.join(path.dirname(fixture.postgres.workDirectory), "outside.pem") },
      { PGAPPNAME: "another-application" },
      { PGCONNECT_TIMEOUT: "11" },
      { PGCHANNELBINDING: "prefer" },
      { DATABASE_URL: "postgresql://forbidden.invalid/db" }
    ];
    for (const mutation of environmentMutations) {
      await rejectsWithoutSecret(
        () => fixture.runTool(planWithEnvironment(plan, mutation), binding),
        "linux_postgres_tool_transport_refused",
        secret
      );
    }

    const dumpOutside = exactBackupPlan(fixture, binding, "pg_dump");
    dumpOutside.args[9] = `--file=${path.join(path.dirname(fixture.postgres.workDirectory), "outside.dump")}`;
    const restoreWrongDatabase = exactBackupPlan(fixture, binding, "pg_restore");
    restoreWrongDatabase.args[5] = "--dbname=ia4tube_social_other";
    const restoreOutside = exactBackupPlan(fixture, binding, "pg_restore");
    restoreOutside.args[6] = path.join(path.dirname(fixture.postgres.workDirectory), "outside.dump");
    const commandMutations = [
      { ...plan, executable: "/usr/bin/curl" },
      { ...plan, executable: "/usr/local/bin/psql" },
      { ...plan, executable: "psql" },
      { ...plan, args: [...plan.args, "--host=external.invalid"] },
      { ...plan, args: [...plan.args, "--port=5433"] },
      { ...plan, args: [...plan.args, "--username=other"] },
      { ...plan, args: [...plan.args, "--dbname=other"] },
      { ...plan, input: undefined },
      dumpOutside,
      restoreWrongDatabase,
      restoreOutside
    ];
    for (const candidate of commandMutations) {
      await rejectsWithoutSecret(
        () => fixture.runTool(candidate, binding),
        "linux_postgres_tool_command_refused",
        secret
      );
    }

    const offline = exactBackupPlan(fixture, binding, "pg_restore_list");
    for (const candidate of [
      { ...offline, env: { PGPASSWORD: secret } },
      { ...offline, args: [...offline.args, "--host=external.invalid"] },
      { ...offline, input: "forbidden" },
      {
        ...offline,
        args: ["--list", path.join(path.dirname(fixture.postgres.workDirectory), "outside.dump")]
      }
    ]) {
      await rejectsWithoutSecret(
        () => fixture.runTool(candidate, binding),
        "linux_postgres_tool_offline_plan_refused",
        secret
      );
    }
    assert.equal(fixture.calls.length, callCount);
  } finally {
    await fixture.destroy();
  }
});

test("pre-validation refusal never marks pg_dump or pg_restore as started", async () => {
  const fixture = await createBackupTransportFixture();
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const invalid = planWithEnvironment(
      exactBackupPlan(fixture, binding, "pg_dump"),
      { PGSSLMODE: "disable" }
    );
    const callCount = fixture.calls.length;
    await assert.rejects(
      () => fixture.runTool(invalid, binding),
      { code: "linux_postgres_tool_transport_refused" }
    );
    assert.equal(fixture.calls.length, callCount);
    assert.deepEqual(fixture.postgres.backupTransportEvidence(), {
      logicalIdentityTlsContractValidated: false,
      physicalDisposableTransportValidated: false,
      productionTlsPhysicallyTestedInThisGate: false,
      productionTlsPreviouslyProvedBySocial2B: true,
      localTlsDisabledOnlyInsideOwnedContainer: false,
      pgDumpStarted: false,
      pgDumpSucceeded: false,
      pgRestoreStarted: false,
      pgRestoreSucceeded: false
    });
  } finally {
    await fixture.destroy();
  }
});

test("pg_dump code 1 records started without recording success", async () => {
  const fixture = await createBackupTransportFixture({
    toolExitCodes: { pg_dump: 1 }
  });
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const callCount = fixture.calls.length;
    const result = await fixture.runTool(
      exactBackupPlan(fixture, binding, "pg_dump"),
      binding
    );
    assert.deepEqual(result, {
      code: 1,
      stdout: "",
      stderr: "synthetic tool failure"
    });
    const calls = fixture.calls.slice(callCount);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[calls[0].args.indexOf(CONTAINER_ID) + 1], "pg_dump");
    assert.deepEqual(fixture.postgres.backupTransportEvidence(), {
      logicalIdentityTlsContractValidated: true,
      physicalDisposableTransportValidated: false,
      productionTlsPhysicallyTestedInThisGate: false,
      productionTlsPreviouslyProvedBySocial2B: true,
      localTlsDisabledOnlyInsideOwnedContainer: true,
      pgDumpStarted: true,
      pgDumpSucceeded: false,
      pgRestoreStarted: false,
      pgRestoreSucceeded: false
    });
  } finally {
    await fixture.destroy();
  }
});

test("pg_restore code 1 records started without recording success", async () => {
  const fixture = await createBackupTransportFixture({
    toolExitCodes: { pg_restore: 1 }
  });
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const callCount = fixture.calls.length;
    const result = await fixture.runTool(
      exactBackupPlan(fixture, binding, "pg_restore"),
      binding
    );
    assert.deepEqual(result, {
      code: 1,
      stdout: "",
      stderr: "synthetic tool failure"
    });
    const calls = fixture.calls.slice(callCount);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[calls[0].args.indexOf(CONTAINER_ID) + 1], "pg_restore");
    assert.deepEqual(fixture.postgres.backupTransportEvidence(), {
      logicalIdentityTlsContractValidated: true,
      physicalDisposableTransportValidated: false,
      productionTlsPhysicallyTestedInThisGate: false,
      productionTlsPreviouslyProvedBySocial2B: true,
      localTlsDisabledOnlyInsideOwnedContainer: true,
      pgDumpStarted: false,
      pgDumpSucceeded: false,
      pgRestoreStarted: true,
      pgRestoreSucceeded: false
    });
  } finally {
    await fixture.destroy();
  }
});

test("tool plan snapshots args once so a getter and later mutation cannot change execution", async () => {
  const fixture = await createBackupTransportFixture();
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const base = exactBackupPlan(fixture, binding, "pg_dump");
    const expectedArgs = [...base.args];
    const sourceArgs = [...expectedArgs];
    const poisonedArgs = [...expectedArgs, "--host=external.invalid"];
    let getterCalls = 0;
    delete base.args;
    Object.defineProperty(base, "args", {
      configurable: false,
      enumerable: true,
      get() {
        getterCalls += 1;
        if (getterCalls !== 1) return poisonedArgs;
        queueMicrotask(() => {
          sourceArgs.splice(0, sourceArgs.length, ...poisonedArgs);
        });
        return sourceArgs;
      }
    });
    const callCount = fixture.calls.length;
    const result = await fixture.runTool(base, binding);
    assert.equal(result.code, 0);
    assert.equal(getterCalls, 1);
    assert.deepEqual(sourceArgs, poisonedArgs);
    const calls = fixture.calls.slice(callCount);
    assert.equal(calls.length, 1);
    const containerIndex = calls[0].args.indexOf(CONTAINER_ID);
    assert.equal(calls[0].args[containerIndex + 1], "pg_dump");
    assert.deepEqual(calls[0].args.slice(containerIndex + 2), expectedArgs);
    assert.equal(calls[0].args.includes("--host=external.invalid"), false);
  } finally {
    await fixture.destroy();
  }
});

test("tool plan snapshots every environment getter once before later mutation", async () => {
  const fixture = await createBackupTransportFixture();
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const base = exactBackupPlan(fixture, binding, "psql");
    const exactEnvironment = { ...base.env };
    const poisonedEnvironment = {
      ...exactEnvironment,
      LANG: "poisoned",
      PGHOST: "external.invalid",
      PGPORT: "5433",
      PGDATABASE: "ia4tube_social_other",
      PGUSER: PROVISIONER_LOGIN,
      PGPASSWORD: "synthetic-poisoned-password-that-must-never-reach-child",
      PGCONNECT_TIMEOUT: "11",
      PGCHANNELBINDING: "prefer",
      PGSSLMODE: "disable",
      PGSSLROOTCERT: "poisoned.crt",
      SSL_CERT_FILE: path.join(path.dirname(fixture.postgres.workDirectory), "outside.pem"),
      PGAPPNAME: "poisoned-application"
    };
    const getterCalls = Object.create(null);
    const getterEnvironment = {};
    for (const name of Object.keys(exactEnvironment)) {
      getterCalls[name] = 0;
      Object.defineProperty(getterEnvironment, name, {
        configurable: false,
        enumerable: true,
        get() {
          getterCalls[name] += 1;
          return getterCalls[name] === 1
            ? exactEnvironment[name]
            : poisonedEnvironment[name];
        }
      });
    }
    let environmentGetterCalls = 0;
    delete base.env;
    Object.defineProperty(base, "env", {
      configurable: false,
      enumerable: true,
      get() {
        environmentGetterCalls += 1;
        return environmentGetterCalls === 1
          ? getterEnvironment
          : poisonedEnvironment;
      }
    });
    queueMicrotask(() => {
      Object.assign(exactEnvironment, poisonedEnvironment);
    });

    const callCount = fixture.calls.length;
    const result = await fixture.runTool(base, binding);
    assert.equal(result.code, 0);
    assert.equal(environmentGetterCalls, 1);
    assert.deepEqual(Object.values(getterCalls), Object.keys(getterCalls).map(() => 1));
    assert.deepEqual(exactEnvironment, poisonedEnvironment);
    const calls = fixture.calls.slice(callCount);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.environment.PGHOST, "127.0.0.1");
    assert.equal(call.environment.PGPORT, "5432");
    assert.equal(call.environment.PGDATABASE, binding.database);
    assert.equal(call.environment.PGUSER, binding.login);
    assert.equal(
      call.environment.PGPASSWORD,
      fixture.postgres.materials.migration.toString("utf8")
    );
    assert.equal(call.environment.PGSSLMODE, "disable");
    assert.equal(call.environment.PGAPPNAME, BACKUP_APPLICATION_NAME);
    assert.equal(JSON.stringify(call).includes("synthetic-poisoned-password"), false);
    assert.equal(JSON.stringify(call).includes("external.invalid"), false);
  } finally {
    await fixture.destroy();
  }
});

test("tool executable must be the exact canonical absolute allowlisted string", async () => {
  const fixture = await createBackupTransportFixture();
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const exact = exactBackupPlan(fixture, binding, "psql");
    const exactResult = await fixture.runTool(exact, binding);
    assert.equal(exactResult.code, 0);
    const callCount = fixture.calls.length;
    for (const executable of [
      "/usr/bin/../bin/psql",
      "/usr/bin/./psql",
      "/usr//bin/psql",
      "\\usr\\bin\\psql"
    ]) {
      await assert.rejects(
        () => fixture.runTool({ ...exact, executable }, binding),
        { code: "linux_postgres_tool_command_refused" }
      );
    }
    assert.equal(fixture.calls.length, callCount);
  } finally {
    await fixture.destroy();
  }
});

test("exact backup, psql and restore plans map only inside the owned container without DNS or exposure", async () => {
  const fixture = await createBackupTransportFixture();
  try {
    const binding = fixture.postgres.createBackupTransportBinding(exactBackupContract());
    const secret = fixture.postgres.materials.migration.toString("utf8");
    const callCount = fixture.calls.length;
    const psqlResult = await fixture.runTool(
      exactBackupPlan(fixture, binding, "psql"),
      binding
    );
    const dumpResult = await fixture.runTool(
      exactBackupPlan(fixture, binding, "pg_dump"),
      binding
    );
    const listResult = await fixture.runTool(
      exactBackupPlan(fixture, binding, "pg_restore_list"),
      binding
    );
    const beforeConnectedRestore = fixture.postgres.backupTransportEvidence();
    assert.equal(beforeConnectedRestore.logicalIdentityTlsContractValidated, true);
    assert.equal(beforeConnectedRestore.physicalDisposableTransportValidated, false);
    assert.equal(beforeConnectedRestore.localTlsDisabledOnlyInsideOwnedContainer, true);
    assert.equal(beforeConnectedRestore.pgDumpStarted, true);
    assert.equal(beforeConnectedRestore.pgDumpSucceeded, true);
    assert.equal(beforeConnectedRestore.pgRestoreStarted, false);
    assert.equal(beforeConnectedRestore.pgRestoreSucceeded, false);
    const restoreResult = await fixture.runTool(
      exactBackupPlan(fixture, binding, "pg_restore"),
      binding
    );
    for (const result of [psqlResult, dumpResult, listResult, restoreResult]) {
      assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
      assert.equal(JSON.stringify(result).includes(secret), false);
    }

    const calls = fixture.calls.slice(callCount);
    assert.equal(calls.length, 4);
    assert.equal(calls.every((call) => call.executable === "docker"), true);
    assert.equal(calls.every((call) => call.args[0] === "exec"), true);
    assert.equal(calls.every((call) => call.args[1] === "--interactive"), true);
    assert.equal(calls.every((call) => call.args[2] === "--user"), true);
    assert.equal(calls.every((call) => call.args[3] === "1001:127"), true);
    for (const call of calls) {
      const containerIndex = call.args.indexOf(CONTAINER_ID);
      assert.ok(containerIndex > 3);
      assert.equal(call.args.filter((argument) => argument === CONTAINER_ID).length, 1);
      assert.ok(["psql", "pg_dump", "pg_restore"].includes(call.args[containerIndex + 1]));
    }
    assert.equal(calls.some((call) => call.args.includes("--publish")), false);
    assert.equal(calls.some((call) => call.args.includes("-p")), false);
    assert.equal(calls.some((call) => call.args.includes("-P")), false);
    assert.equal(calls.some((call) => call.args[0] === "port"), false);
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
    assert.equal(JSON.stringify(calls.map((call) => call.args)).includes(BACKUP_LOGICAL_HOST), false);
    assert.equal(JSON.stringify(calls.map((call) => call.args)).includes(secret), false);

    const online = calls.filter((call) => !call.args.includes("--list"));
    assert.equal(online.length, 3);
    for (const call of online) {
      assert.equal(call.environment.PGHOST, "127.0.0.1");
      assert.equal(call.environment.PGPORT, "5432");
      assert.equal(call.environment.PGDATABASE, binding.database);
      assert.equal(call.environment.PGUSER, binding.login);
      assert.equal(call.environment.PGPASSWORD, secret);
      assert.equal(call.environment.PGSSLMODE, "disable");
      assert.equal(call.environment.PGCHANNELBINDING, "disable");
      assert.equal(call.environment.PGCONNECT_TIMEOUT, "10");
      assert.equal(call.environment.PGAPPNAME, BACKUP_APPLICATION_NAME);
      assert.equal(Object.hasOwn(call.environment, "PGSSLROOTCERT"), false);
      assert.equal(Object.hasOwn(call.environment, "SSL_CERT_FILE"), false);
      assert.ok(call.args.includes("PGPASSWORD"));
      assert.ok(call.args.includes("PGHOST"));
      assert.ok(call.args.indexOf(CONTAINER_ID) < call.args.length - 1);
    }
    const offline = calls.find((call) => call.args.includes("--list"));
    assert.ok(offline);
    assert.deepEqual(offline.environment, {});
    assert.equal(offline.args.includes("--env"), false);
    assert.equal(offline.args.includes("PGPASSWORD"), false);

    const evidence = fixture.postgres.backupTransportEvidence();
    assert.equal(Object.isFrozen(evidence), true);
    assert.deepEqual(evidence, {
      logicalIdentityTlsContractValidated: true,
      physicalDisposableTransportValidated: true,
      productionTlsPhysicallyTestedInThisGate: false,
      productionTlsPreviouslyProvedBySocial2B: true,
      localTlsDisabledOnlyInsideOwnedContainer: true,
      pgDumpStarted: true,
      pgDumpSucceeded: true,
      pgRestoreStarted: true,
      pgRestoreSucceeded: true
    });
    const evidenceText = JSON.stringify(evidence);
    assert.equal(evidenceText.includes(secret), false);
    assert.equal(evidenceText.includes(CONTAINER_ID), false);
    assert.equal(evidenceText.includes(BACKUP_LOGICAL_HOST), false);
    assert.equal(evidenceText.includes("127.0.0.1"), false);

    const implementation = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "social-3a0p-linux-postgres.js"),
      "utf8"
    );
    assert.doesNotMatch(implementation, /require\(["'](?:node:)?dns["']\)/);
    assert.doesNotMatch(implementation, /\bdns\.(?:lookup|resolve|resolve4|resolve6)\b/);
  } finally {
    await fixture.destroy();
  }
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

test("cleanup closes every tracked pool, completes physical cleanup, and rethrows the first close error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-pg-close-error-"));
  const firstError = new Error("first_pool_close_failed");
  const secondError = new Error("second_pool_close_failed");
  const closed = [];
  const commands = [];
  class CleanupFailingPool extends FakePool {
    end() {
      closed.push(this.configuration.application_name);
      throw this.configuration.closeError;
    }
  }
  const postgres = createLinuxPostgres({
    runnerTemp: root,
    runId: "linux-271828",
    PoolClass: CleanupFailingPool,
    metricsRegistry: metrics(),
    runnerUid: 1001,
    runnerGid: 127,
    async runCommand(executable, args) {
      commands.push({ executable, args: [...args] });
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
    randomBytes: (size) => Buffer.alloc(size, 7)
  });
  try {
    new postgres.InstrumentedPool({
      max: 1,
      application_name: "first-runtime",
      closeError: firstError
    });
    new postgres.InstrumentedPool({
      max: 1,
      application_name: "second-migration",
      closeError: secondError
    });
    assert.equal(postgres.trackedPoolCount, 2);
    await assert.rejects(postgres.cleanup(), (error) => error === firstError);
    assert.deepEqual(closed, ["first-runtime", "second-migration"]);
    assert.equal(postgres.trackedPoolCount, 0);
    assert.ok(commands.some((call) => call.executable === "docker" && call.args[0] === "ps"));
    assert.ok(commands.some((call) => call.executable === "docker" && call.args[0] === "volume"));
    assert.ok(commands.some((call) => call.executable === "docker" && call.args[0] === "network"));
    assert.equal((await postgres.cleanup()).cleanupCompleted, true);
    assert.deepEqual(closed, ["first-runtime", "second-migration"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
