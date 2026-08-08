"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const IMAGE = "docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const IMAGE_DIGEST = "sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const LOOPBACK = "127.0.0.1";
const INTERNAL_PORT = 5432;
const POSTGRES_CONNECTIVITY_MODE = "internal_bridge_direct_v1";
const BACKUP_CONNECTIVITY_MODE = "logical_dns_to_internal_container_v1";
const BACKUP_LOGICAL_HOST = "backup.local.ia4tube.invalid";
const BACKUP_PHYSICAL_MODE = "internal_container_loopback";
const BACKUP_APPLICATION_NAME = "ia4tube-social-backup-restore";
const ADMIN_LOGIN = "ia4tube_social_local_admin";
const PROVISIONER_LOGIN = "ia4tube_social_local_provisioner";
const MIGRATION_LOGIN = "ia4tube_social_local_migration";
const RUNTIME_LOGIN = "ia4tube_social_local_runtime";
const DATABASE = "ia4tube_social_local";
const OWNER_ROLE = "ia4tube_social_owner";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SAFE_DATABASE = /^[a-z][a-z0-9_]{2,62}$/;
const BACKUP_RUN_MARKER = /^ia4tube-social-3a0p-[a-z0-9-]{8,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_LOGIN = new Set([MIGRATION_LOGIN, PROVISIONER_LOGIN]);
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const EMPTY_IDENTITY_HASH = "0".repeat(64);
const IDENTITY_MARKER_FORMAT = "ia4tube-social-3a0p-resource-identity-v1";
const INTERNAL_PORT_KEY = `${INTERNAL_PORT}/tcp`;
const BACKUP_ENVIRONMENT_NAMES = new Set([
  "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
  "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
  "PGCONNECT_TIMEOUT", "PGCHANNELBINDING", "PGSSLMODE", "PGSSLROOTCERT",
  "SSL_CERT_FILE", "PGAPPNAME"
]);
const BACKUP_SYSTEM_ENVIRONMENT_NAMES = new Set([
  "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"
]);
const BACKUP_PSQL_ARGS = Object.freeze([
  "--no-password", "--no-psqlrc", "--set=ON_ERROR_STOP=1",
  "--set=VERBOSITY=terse", "--quiet", "--file=-"
]);
const DIAGNOSTIC_KEY_LIST = Object.freeze([
  "networkCreated", "networkInternal", "networkDriverClass",
  "containerCreated", "containerRunning", "containerNetworkCount",
  "containerIpPresent", "containerIpWithinSubnet", "portBindingsAbsent",
  "publishedPortsAbsent", "internalReadinessPassed",
  "hostDirectConnectionAttempted", "hostDirectConnectionPassed",
  "hostListenerAbsent", "failureStage", "sanitizedFailureCode",
  "cleanupCompleted"
]);
const DIAGNOSTIC_KEYS = new Set(DIAGNOSTIC_KEY_LIST);
const NETWORK_DRIVER_CLASSES = new Set(["not_observed", "bridge", "other"]);
const FAILURE_STAGES = new Set([
  "unknown", "pre_network", "network_create", "network_id", "volume_create",
  "docker_run", "container_id", "internal_readiness", "network_inspect",
  "network_inspect_parse", "network_identity", "network_configuration",
  "network_ipam", "container_inspect", "container_inspect_parse",
  "container_identity", "container_state", "container_security",
  "container_network", "container_ports", "container_listing",
  "host_listener", "host_direct_connection", "complete", "cleanup"
]);
const SAFE_FAILURE_CODE = /^linux_[a-z0-9_]{3,92}$/;

function diagnosticDefaults() {
  return {
    networkCreated: false,
    networkInternal: false,
    networkDriverClass: "not_observed",
    containerCreated: false,
    containerRunning: false,
    containerNetworkCount: 0,
    containerIpPresent: false,
    containerIpWithinSubnet: false,
    portBindingsAbsent: false,
    publishedPortsAbsent: false,
    internalReadinessPassed: false,
    hostDirectConnectionAttempted: false,
    hostDirectConnectionPassed: false,
    hostListenerAbsent: false,
    failureStage: "unknown",
    sanitizedFailureCode: "not_observed",
    cleanupCompleted: false
  };
}

function sanitizedDiagnostic(value = {}) {
  const result = diagnosticDefaults();
  for (const [key, entry] of Object.entries(value || {})) {
    if (!DIAGNOSTIC_KEYS.has(key)) continue;
    if (key === "containerNetworkCount") {
      result[key] = Number.isSafeInteger(entry) && entry >= 0 && entry <= 1000 ? entry : 0;
    } else if (key === "networkDriverClass") {
      result[key] = NETWORK_DRIVER_CLASSES.has(entry) ? entry : "not_observed";
    } else if (key === "failureStage") {
      result[key] = FAILURE_STAGES.has(entry) ? entry : "unknown";
    } else if (key === "sanitizedFailureCode") {
      result[key] = entry === "not_observed" || SAFE_FAILURE_CODE.test(entry)
        ? entry
        : "linux_postgres_failure_code_invalid";
    } else {
      result[key] = entry === true;
    }
  }
  return Object.freeze(result);
}

function postgresFailureDiagnostics(error) {
  if (!(error instanceof LinuxPostgresFailure)) return null;
  const value = error.linuxPostgresDiagnostic;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== DIAGNOSTIC_KEY_LIST.length ||
    keys.some((key, index) => key !== [...DIAGNOSTIC_KEY_LIST].sort()[index])
  ) return null;
  if (
    typeof value.networkCreated !== "boolean" ||
    typeof value.networkInternal !== "boolean" ||
    !NETWORK_DRIVER_CLASSES.has(value.networkDriverClass) ||
    typeof value.containerCreated !== "boolean" ||
    typeof value.containerRunning !== "boolean" ||
    !Number.isSafeInteger(value.containerNetworkCount) || value.containerNetworkCount < 0 || value.containerNetworkCount > 1000 ||
    typeof value.containerIpPresent !== "boolean" ||
    typeof value.containerIpWithinSubnet !== "boolean" ||
    typeof value.portBindingsAbsent !== "boolean" ||
    typeof value.publishedPortsAbsent !== "boolean" ||
    typeof value.internalReadinessPassed !== "boolean" ||
    typeof value.hostDirectConnectionAttempted !== "boolean" ||
    typeof value.hostDirectConnectionPassed !== "boolean" ||
    typeof value.hostListenerAbsent !== "boolean" ||
    !FAILURE_STAGES.has(value.failureStage) ||
    !(value.sanitizedFailureCode === "not_observed" || SAFE_FAILURE_CODE.test(value.sanitizedFailureCode)) ||
    typeof value.cleanupCompleted !== "boolean"
  ) return null;
  return Object.freeze({ ...value });
}

class LinuxPostgresFailure extends Error {
  constructor(code, diagnostic) {
    super(code);
    this.name = "LinuxPostgresFailure";
    this.code = code;
    Object.defineProperty(this, "linuxPostgresDiagnostic", {
      value: sanitizedDiagnostic({ ...diagnostic, sanitizedFailureCode: code }),
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
}

function fail(code, diagnostic) {
  throw new LinuxPostgresFailure(code, diagnostic);
}

function classifyHostListenerRows(rows, port) {
  if (!Array.isArray(rows) || port !== INTERNAL_PORT) {
    fail("linux_postgres_listener_exposure_invalid");
  }
  if (rows.length !== 0) fail("linux_postgres_listener_exposure_invalid");
  return "none_observed";
}

function commandOutcome(result) {
  return {
    exitCodeClass: Number.isInteger(result?.code)
      ? (result.code === 0 ? "zero" : "nonzero")
      : "no_exit_code",
    signalPresent: result?.signal != null,
    stdoutPresent: typeof result?.stdout === "string" && result.stdout.length !== 0,
    stderrPresent: typeof result?.stderr === "string" && result.stderr.length !== 0
  };
}

function assertCommandSucceeded(result, code, diagnostic) {
  const outcome = commandOutcome(result);
  if (outcome.exitCodeClass !== "zero" || outcome.signalPresent) fail(code, diagnostic);
  return result;
}

function beginFailureStage(diagnostic, failureStage) {
  diagnostic.failureStage = failureStage;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseStructuredObject(stdout, code, diagnostic) {
  let value;
  try { value = JSON.parse(String(stdout || "").trim()); } catch { fail(code, diagnostic); }
  if (!plainObject(value)) fail(code, diagnostic);
  return value;
}

function ipv4Number(value) {
  if (typeof value !== "string" || net.isIPv4(value) !== true) return null;
  const octets = value.split(".").map(Number);
  if (octets.join(".") !== value) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function privateIpv4(value) {
  const number = ipv4Number(value);
  if (number == null) return false;
  return privateIpv4Range(number) != null;
}

function privateIpv4Range(number) {
  for (const [first, last] of [
    [0x0a000000, 0x0affffff],
    [0xac100000, 0xac1fffff],
    [0xc0a80000, 0xc0a8ffff]
  ]) {
    if (number >= first && number <= last) return Object.freeze({ first, last });
  }
  return null;
}

function parsePrivateIpv4Cidr(value, diagnostic) {
  const match = typeof value === "string" ? value.match(/^([^/]+)\/([0-9]{1,2})$/) : null;
  const address = match?.[1] || "";
  const prefix = Number(match?.[2]);
  const number = ipv4Number(address);
  if (
    number == null || !Number.isInteger(prefix) || String(prefix) !== match?.[2] ||
    prefix < 8 || prefix > 30
  ) {
    fail("linux_postgres_network_ipam_invalid", diagnostic);
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const first = (number & mask) >>> 0;
  const last = (first | (~mask >>> 0)) >>> 0;
  const privateRange = privateIpv4Range(first);
  if (number !== first || privateRange == null || last > privateRange.last) {
    fail("linux_postgres_network_ipam_invalid", diagnostic);
  }
  return Object.freeze({ first, last, prefix });
}

function ipv4InCidr(value, cidr, { usable = true } = {}) {
  const number = ipv4Number(value);
  return number != null && privateIpv4(value) && number >= cidr.first && number <= cidr.last &&
    (!usable || (number !== cidr.first && number !== cidr.last));
}

function inspectInternalNetwork(stdout, { networkId, containerId, names, diagnostic = {} }) {
  const state = { ...diagnostic, failureStage: "network_inspect_parse" };
  const value = parseStructuredObject(stdout, "linux_postgres_network_inspect_invalid", state);
  const [labelKey, labelValue] = names.label.split("=", 2);
  if (
    value.Id !== networkId || value.Name !== names.network || value.Scope !== "local" ||
    value.Labels?.[labelKey] !== labelValue
  ) fail("linux_postgres_network_identity_invalid", { ...state, failureStage: "network_identity" });

  state.networkDriverClass = value.Driver === "bridge" ? "bridge" : "other";
  state.networkInternal = value.Internal === true;
  if (
    state.networkDriverClass !== "bridge" || !state.networkInternal ||
    value.Attachable !== false || value.Ingress !== false || value.EnableIPv6 === true ||
    !plainObject(value.Options) || Object.keys(value.Options).length !== 0
  ) fail("linux_postgres_network_configuration_invalid", { ...state, failureStage: "network_configuration" });

  const ipam = value.IPAM;
  if (
    !plainObject(ipam) || ipam.Driver !== "default" ||
    !(ipam.Options == null || (plainObject(ipam.Options) && Object.keys(ipam.Options).length === 0)) ||
    !Array.isArray(ipam.Config) || ipam.Config.length !== 1 || !plainObject(ipam.Config[0])
  ) fail("linux_postgres_network_ipam_invalid", { ...state, failureStage: "network_ipam" });
  const ipamDiagnostic = { ...state, failureStage: "network_ipam" };
  const cidr = parsePrivateIpv4Cidr(ipam.Config[0].Subnet, ipamDiagnostic);
  const gateway = ipam.Config[0].Gateway;
  if (!ipv4InCidr(gateway, cidr)) fail("linux_postgres_network_ipam_invalid", ipamDiagnostic);

  const containers = value.Containers;
  if (!plainObject(containers) || Object.keys(containers).length !== 1 || !plainObject(containers[containerId])) {
    fail("linux_postgres_container_network_invalid", { ...state, failureStage: "container_network" });
  }
  const networkContainer = containers[containerId];
  if (
    networkContainer.Name !== names.container ||
    typeof networkContainer.IPv4Address !== "string" ||
    networkContainer.IPv4Address.length === 0 ||
    !(networkContainer.IPv6Address == null || networkContainer.IPv6Address === "")
  ) fail("linux_postgres_container_network_invalid", { ...state, failureStage: "container_network" });
  return Object.freeze({ cidr, gateway, networkContainer, diagnostic: sanitizedDiagnostic(state) });
}

function absentPortBindings(value) {
  return value == null || (plainObject(value) && Object.keys(value).length === 0);
}

function unpublishedPorts(value) {
  if (value == null) return true;
  if (!plainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 0 || (keys.length === 1 && keys[0] === INTERNAL_PORT_KEY && value[INTERNAL_PORT_KEY] == null);
}

function inspectInternalContainer(stdout, { containerId, networkId, names, network, diagnostic = {} }) {
  const state = { ...diagnostic, failureStage: "container_inspect_parse" };
  const value = parseStructuredObject(stdout, "linux_postgres_container_inspect_invalid", state);
  const [labelKey, labelValue] = names.label.split("=", 2);
  if (
    value.Id !== containerId || value.Name !== `/${names.container}` ||
    value.Config?.Labels?.[labelKey] !== labelValue
  ) fail("linux_postgres_container_identity_invalid", { ...state, failureStage: "container_identity" });
  state.containerRunning = value.State?.Running === true;
  if (!state.containerRunning || value.State?.Paused !== false) {
    fail("linux_postgres_container_state_invalid", { ...state, failureStage: "container_state" });
  }
  if (
    value.HostConfig?.Privileged !== false || value.HostConfig?.NetworkMode !== names.network ||
    value.HostConfig?.PublishAllPorts !== false
  ) fail("linux_postgres_container_security_invalid", { ...state, failureStage: "container_security" });

  state.portBindingsAbsent = absentPortBindings(value.HostConfig?.PortBindings);
  state.publishedPortsAbsent = unpublishedPorts(value.NetworkSettings?.Ports);
  if (!state.portBindingsAbsent || !state.publishedPortsAbsent) {
    fail("linux_postgres_published_port_refused", { ...state, failureStage: "container_ports" });
  }

  const networks = value.NetworkSettings?.Networks;
  state.containerNetworkCount = plainObject(networks) ? Object.keys(networks).length : 0;
  const attachment = plainObject(networks) ? networks[names.network] : null;
  if (state.containerNetworkCount !== 1 || !plainObject(attachment) || attachment.NetworkID !== networkId) {
    fail("linux_postgres_container_network_invalid", { ...state, failureStage: "container_network" });
  }
  const address = attachment.IPAddress;
  state.containerIpPresent = typeof address === "string" && address.length !== 0;
  state.containerIpWithinSubnet = state.containerIpPresent &&
    ipv4InCidr(address, network.cidr) && address !== network.gateway;
  const expectedCidr = `${address}/${network.cidr.prefix}`;
  if (
    !state.containerIpWithinSubnet || attachment.IPPrefixLen !== network.cidr.prefix ||
    attachment.Gateway !== "" ||
    !(attachment.GlobalIPv6Address == null || attachment.GlobalIPv6Address === "") ||
    network.networkContainer.IPv4Address !== expectedCidr
  ) fail("linux_postgres_container_ip_invalid", { ...state, failureStage: "container_network" });
  return Object.freeze({ databaseHost: address, diagnostic: sanitizedDiagnostic(state) });
}

function inspectContainerListing(stdout, { containerId, names, diagnostic = {} }) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) fail("linux_postgres_container_listing_invalid", diagnostic);
  const value = parseStructuredObject(lines[0], "linux_postgres_container_listing_invalid", diagnostic);
  if (
    value.ID !== containerId || value.Names !== names.container || value.Networks !== names.network ||
    !new Set(["", INTERNAL_PORT_KEY]).has(String(value.Ports || "")) ||
    String(value.Ports || "").includes("->")
  ) fail("linux_postgres_container_listing_invalid", diagnostic);
  return true;
}

function assertAbsoluteWithin(candidate, root, code) {
  if (typeof candidate !== "string" || typeof root !== "string") fail(code);
  const absolute = path.resolve(candidate);
  const base = path.resolve(root);
  const relative = path.relative(base, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(code);
  }
  return absolute;
}

function safeRunId(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48);
  if (!SAFE_RUN_ID.test(normalized)) fail("linux_postgres_run_id_invalid");
  return normalized;
}

function secretText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 43) fail("linux_postgres_material_invalid");
  const value = buffer.toString("utf8");
  if (!/^[A-Za-z0-9_-]{43,96}$/.test(value)) fail("linux_postgres_material_invalid");
  return value;
}

function generatedSecret(randomBytes = crypto.randomBytes) {
  return Buffer.from(`aA0_${randomBytes(48).toString("base64url")}`, "utf8");
}

function commandRunner({ spawnImpl = spawn, baseEnvironment = process.env } = {}) {
  return function run(executable, args, options = {}) {
    if (typeof executable !== "string" || !Array.isArray(args) || args.some((item) => typeof item !== "string")) {
      fail("linux_command_invalid");
    }
    const timeoutMs = Number(options.timeoutMs || 120_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000) {
      fail("linux_command_timeout_invalid");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let child;
      try {
        child = spawnImpl(executable, args, {
          cwd: options.cwd,
          env: { ...baseEnvironment, ...(options.environment || {}) },
          shell: false,
          windowsHide: true,
          stdio: [options.input == null ? "ignore" : "pipe", "pipe", "pipe"]
        });
      } catch {
        reject(new LinuxPostgresFailure(
          options.failureCode || "linux_command_spawn_failed",
          { exitCodeClass: "no_exit_code", signalPresent: false, stdoutPresent: false, stderrPresent: false }
        ));
        return;
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      timer.unref?.();
      const append = (current, chunk) => {
        if (current.length >= 16 * 1024 * 1024) return current;
        return Buffer.concat([current, Buffer.from(chunk)]).subarray(0, 16 * 1024 * 1024);
      };
      child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const diagnostic = commandOutcome({ code: null, signal: null, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
        stdout.fill(0);
        stderr.fill(0);
        reject(new LinuxPostgresFailure(options.failureCode || "linux_command_spawn_failed", diagnostic));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = Object.freeze({
          code: Number.isInteger(code) ? code : -1,
          signal: signal || null,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8")
        });
        stdout.fill(0);
        stderr.fill(0);
        if (timedOut) {
          reject(new LinuxPostgresFailure(`${options.failureCode || "linux_command"}_timeout`, commandOutcome(result)));
        } else if ((result.code !== 0 || result.signal !== null) && options.allowFailure !== true) {
          reject(new LinuxPostgresFailure(options.failureCode || "linux_command_failed", commandOutcome(result)));
        } else {
          resolve(result);
        }
      });
      if (options.input != null) {
        const input = Buffer.isBuffer(options.input) ? options.input : Buffer.from(String(options.input), "utf8");
        child.stdin.end(input);
      }
    });
  };
}

function quoteIdentifier(value) {
  if (!SAFE_DATABASE.test(value)) fail("linux_postgres_identifier_invalid");
  return `"${value}"`;
}

function poolOptions({ host, port, database, login, password, max, applicationName }) {
  if (!privateIpv4(host) || port !== INTERNAL_PORT) fail("linux_postgres_pool_transport_invalid");
  return {
    host,
    port,
    database,
    user: login,
    password,
    ssl: false,
    max,
    min: 0,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    query_timeout: 20_000,
    application_name: applicationName,
    options: "-c statement_timeout=15000 -c lock_timeout=7000 -c idle_in_transaction_session_timeout=7000",
    allowExitOnIdle: false
  };
}

function instrumentedPoolClass(Pool, metricsRegistry, trackedPools = null) {
  if (
    typeof Pool !== "function" || !metricsRegistry ||
    (trackedPools !== null && (
      typeof trackedPools.add !== "function" ||
      typeof trackedPools.delete !== "function"
    ))
  ) fail("linux_pool_instrumentation_invalid");
  return class LinuxInstrumentedPool extends Pool {
    constructor(configuration = {}) {
      super(configuration);
      const applicationName = String(configuration.application_name || "");
      const category = applicationName.includes("runtime")
        ? "runtime"
        : applicationName.includes("migration")
          ? "migration"
          : applicationName.includes("provisioner")
            ? "provisioning"
            : "administration";
      const lifecycle = {
        state: "active",
        callbacks: null,
        endPromise: null,
        endCallbacks: [],
        baseCallbackArgs: null,
        settled: false,
        settledCallbackArgs: null,
        callbackRejectionObserved: false,
        unregisterAttempted: false,
        trackedDeleteAttempted: false
      };
      const permitsMetrics = () => (
        lifecycle.state === "active" || lifecycle.state === "draining"
      );
      const callbacks = Object.freeze({
        connect: () => {
          if (permitsMetrics()) metricsRegistry.observe(this, this);
        },
        acquire: () => {
          if (permitsMetrics()) metricsRegistry.recordAcquisition(this, this);
        },
        remove: () => {
          if (permitsMetrics()) metricsRegistry.observe(this, this);
        }
      });
      lifecycle.callbacks = callbacks;
      Object.defineProperty(this, "linuxMetricsLifecycle", {
        value: lifecycle,
        enumerable: false,
        configurable: false,
        writable: false
      });
      metricsRegistry.register(this, { category, configuredMax: Number(configuration.max) });
      this.on("connect", callbacks.connect);
      this.on("acquire", callbacks.acquire);
      this.on("remove", callbacks.remove);
      metricsRegistry.observe(this, this);
      trackedPools?.add(this);
    }

    end(...args) {
      const lifecycle = this.linuxMetricsLifecycle;
      const baseArgs = [...args];
      const endCallback = typeof baseArgs[baseArgs.length - 1] === "function"
        ? baseArgs.pop()
        : null;
      if (endCallback) {
        if (lifecycle.settled) {
          endCallback(...lifecycle.settledCallbackArgs);
        } else {
          lifecycle.endCallbacks.push(endCallback);
        }
        if (lifecycle.endPromise && !lifecycle.callbackRejectionObserved) {
          lifecycle.callbackRejectionObserved = true;
          void lifecycle.endPromise.then(undefined, () => undefined);
        }
      }
      if (lifecycle.endPromise) return lifecycle.endPromise;
      if (lifecycle.state !== "active") fail("linux_pool_lifecycle_invalid");
      lifecycle.state = "draining";

      lifecycle.endPromise = Promise.resolve().then(async () => {
        let result;
        let primaryError;
        let primaryFailed = false;
        let teardownError;
        let teardownFailed = false;
        const captureTeardownFailure = (action) => {
          try {
            action();
          } catch (error) {
            if (!teardownFailed) {
              teardownError = error;
              teardownFailed = true;
            }
          }
        };

        try {
          if (endCallback) {
            result = await new Promise((resolve, reject) => {
              super.end(...baseArgs, (...callbackArgs) => {
                lifecycle.baseCallbackArgs = callbackArgs;
                if (callbackArgs[0]) reject(callbackArgs[0]);
                else resolve(callbackArgs[1]);
              });
            });
          } else {
            result = await super.end(...baseArgs);
          }
        } catch (error) {
          primaryError = error;
          primaryFailed = true;
        }

        captureTeardownFailure(() => metricsRegistry.observe(this, this));
        lifecycle.state = "detached";
        let removeListener = null;
        captureTeardownFailure(() => {
          const method = typeof this.off === "function" ? this.off : this.removeListener;
          if (typeof method !== "function") fail("linux_pool_listener_detach_invalid");
          removeListener = method.bind(this);
        });
        if (removeListener) {
          for (const eventName of ["connect", "acquire", "remove"]) {
            captureTeardownFailure(() => {
              removeListener(eventName, lifecycle.callbacks[eventName]);
            });
          }
        }
        if (!lifecycle.unregisterAttempted) {
          lifecycle.unregisterAttempted = true;
          captureTeardownFailure(() => metricsRegistry.unregister(this));
        }
        if (trackedPools !== null && !lifecycle.trackedDeleteAttempted) {
          lifecycle.trackedDeleteAttempted = true;
          captureTeardownFailure(() => trackedPools.delete(this));
        }
        lifecycle.state = "closed";

        const completionFailed = primaryFailed || teardownFailed;
        const completionError = primaryFailed ? primaryError : teardownError;
        lifecycle.settledCallbackArgs = completionFailed
          ? [completionError]
          : lifecycle.baseCallbackArgs || [];
        lifecycle.settled = true;
        let callbackError;
        let callbackFailed = false;
        for (const callback of lifecycle.endCallbacks.splice(0)) {
          try {
            callback(...lifecycle.settledCallbackArgs);
          } catch (error) {
            if (!callbackFailed) {
              callbackError = error;
              callbackFailed = true;
            }
          }
        }

        if (completionFailed) throw completionError;
        if (callbackFailed) throw callbackError;
        return result;
      });
      if (endCallback && !lifecycle.callbackRejectionObserved) {
        lifecycle.callbackRejectionObserved = true;
        void lifecycle.endPromise.then(undefined, () => undefined);
      }
      return lifecycle.endPromise;
    }
  };
}

function dockerNames(runId) {
  const suffix = crypto.createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return Object.freeze({
    container: `ia4tube-social-3a0p-pg-${suffix}`,
    network: `ia4tube-social-3a0p-net-${suffix}`,
    volume: `ia4tube-social-3a0p-data-${suffix}`,
    label: `ia4tube.social3a0p.run=${suffix}`,
    suffix
  });
}

function resourceIdentityHash(resourceId) {
  return crypto.createHash("sha256").update(resourceId, "ascii").digest("hex");
}

function identityMarkerText({ networkSha256, containerState, containerSha256, volumeSha256 }) {
  if (
    !CONTAINER_ID.test(networkSha256) || networkSha256 === EMPTY_IDENTITY_HASH ||
    !new Set(["pending", "present"]).has(containerState) ||
    !CONTAINER_ID.test(containerSha256) ||
    (containerState === "pending") !== (containerSha256 === EMPTY_IDENTITY_HASH) ||
    !CONTAINER_ID.test(volumeSha256) || volumeSha256 === EMPTY_IDENTITY_HASH
  ) fail("linux_postgres_identity_marker_invalid");
  return [
    `format=${IDENTITY_MARKER_FORMAT}`,
    `networkSha256=${networkSha256}`,
    `containerState=${containerState}`,
    `containerSha256=${containerSha256}`,
    `volumeSha256=${volumeSha256}`,
    ""
  ].join("\n");
}

const IDENTITY_MARKER_SIZE = Buffer.byteLength(identityMarkerText({
  networkSha256: "1".repeat(64),
  containerState: "pending",
  containerSha256: EMPTY_IDENTITY_HASH,
  volumeSha256: "2".repeat(64)
}), "ascii");

function createLinuxPostgres(options = {}) {
  const runnerTemp = path.resolve(String(options.runnerTemp || ""));
  const runId = safeRunId(options.runId);
  const names = dockerNames(runId);
  const runRoot = assertAbsoluteWithin(path.join(runnerTemp, `ia4tube-social-3a0p-linux-${names.suffix}`), runnerTemp, "linux_postgres_root_invalid");
  const dataDirectory = path.join(runRoot, "pgdata");
  const workDirectory = path.join(runRoot, "work");
  const passwordFile = path.join(runRoot, "admin-password");
  const containerIdentityMarker = assertAbsoluteWithin(
    path.join(runnerTemp, `.ia4tube-social-3a0p-container-${names.suffix}.identity`),
    runnerTemp,
    "linux_postgres_root_invalid"
  );
  const run = options.runCommand || commandRunner(options);
  const PoolClass = options.PoolClass;
  const metricsRegistry = options.metricsRegistry;
  const runnerUid = options.runnerUid ?? process.getuid?.();
  const runnerGid = options.runnerGid ?? process.getgid?.();
  const readinessDelay = typeof options.readinessDelay === "function"
    ? options.readinessDelay
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (
    typeof PoolClass !== "function" || !metricsRegistry ||
    !Number.isSafeInteger(runnerUid) || runnerUid < 1 ||
    !Number.isSafeInteger(runnerGid) || runnerGid < 0
  ) fail("linux_postgres_dependencies_invalid");
  const trackedPools = new Set();
  const InstrumentedPool = instrumentedPoolClass(PoolClass, metricsRegistry, trackedPools);
  const materials = Object.freeze({
    admin: generatedSecret(options.randomBytes),
    provisioner: generatedSecret(options.randomBytes),
    migration: generatedSecret(options.randomBytes),
    runtime: generatedSecret(options.randomBytes),
    vault: options.randomBytes ? options.randomBytes(32) : crypto.randomBytes(32)
  });
  let port = 0;
  let started = false;
  let containerId = "";
  let networkId = "";
  let volumeCreated = false;
  let databaseHost = "";
  const backupTransportAttemptedExecutables = new Set();
  const backupTransportSucceededExecutables = new Set();
  const issuedBackupTransportBindings = new WeakSet();
  const expectedBackupRunMarker = `ia4tube-social-3a0p-linux-${crypto
    .createHash("sha256")
    .update(runId)
    .digest("hex")
    .slice(0, 16)}`;

  function ownedBackupDatabase(database, runMarker) {
    if (!SAFE_DATABASE.test(String(database || ""))) return false;
    if (database === DATABASE) return true;
    const suffix = crypto.createHash("sha256").update(runMarker).digest("hex").slice(0, 12);
    return database.startsWith("ia4tube_social_disposable_") && database.endsWith(`_${suffix}`);
  }

  function backupTargetFingerprint(database) {
    return crypto.createHash("sha256").update([
      "ia4tube-social-backup-target-v2",
      BACKUP_LOGICAL_HOST,
      String(INTERNAL_PORT),
      database,
      "tls-verify-full"
    ].join("/")).digest("hex");
  }

  function createBackupTransportBinding(contract) {
    const keys = ["database", "login", "runMarker", "targetFingerprint"];
    if (
      !contract || Object.getPrototypeOf(contract) !== Object.prototype ||
      JSON.stringify(Object.keys(contract).sort()) !== JSON.stringify(keys) ||
      !started || !CONTAINER_ID.test(containerId) || !privateIpv4(databaseHost) ||
      port !== INTERNAL_PORT ||
      contract.runMarker !== expectedBackupRunMarker ||
      !BACKUP_RUN_MARKER.test(contract.runMarker) ||
      !ownedBackupDatabase(contract.database, contract.runMarker) ||
      !SAFE_LOGIN.has(contract.login) ||
      !SHA256.test(String(contract.targetFingerprint || "")) ||
      contract.targetFingerprint !== backupTargetFingerprint(contract.database)
    ) {
      fail("linux_postgres_backup_transport_contract_invalid");
    }
    const localBinding = Object.freeze({
      connectivityMode: BACKUP_CONNECTIVITY_MODE,
      logicalHost: BACKUP_LOGICAL_HOST,
      logicalPort: INTERNAL_PORT,
      physicalMode: BACKUP_PHYSICAL_MODE,
      physicalHost: LOOPBACK,
      physicalPort: INTERNAL_PORT,
      database: contract.database,
      login: contract.login,
      runMarker: contract.runMarker,
      targetFingerprint: contract.targetFingerprint,
      containerIdentityDigest: resourceIdentityHash(containerId)
    });
    issuedBackupTransportBindings.add(localBinding);
    return localBinding;
  }

  function requireBackupTransportBinding(localBinding) {
    const keys = [
      "connectivityMode", "containerIdentityDigest", "database", "logicalHost",
      "logicalPort", "login", "physicalHost", "physicalMode", "physicalPort",
      "runMarker", "targetFingerprint"
    ];
    if (
      !localBinding || Object.getPrototypeOf(localBinding) !== Object.prototype ||
      !issuedBackupTransportBindings.has(localBinding) ||
      JSON.stringify(Object.keys(localBinding).sort()) !== JSON.stringify(keys) ||
      !Object.isFrozen(localBinding) ||
      localBinding.connectivityMode !== BACKUP_CONNECTIVITY_MODE ||
      localBinding.logicalHost !== BACKUP_LOGICAL_HOST ||
      localBinding.logicalPort !== INTERNAL_PORT ||
      localBinding.physicalMode !== BACKUP_PHYSICAL_MODE ||
      localBinding.physicalHost !== LOOPBACK ||
      localBinding.physicalPort !== INTERNAL_PORT ||
      localBinding.runMarker !== expectedBackupRunMarker ||
      !BACKUP_RUN_MARKER.test(localBinding.runMarker) ||
      !ownedBackupDatabase(localBinding.database, localBinding.runMarker) ||
      !SAFE_LOGIN.has(localBinding.login) ||
      localBinding.targetFingerprint !== backupTargetFingerprint(localBinding.database) ||
      localBinding.containerIdentityDigest !== resourceIdentityHash(containerId)
    ) {
      fail("linux_postgres_backup_transport_binding_invalid");
    }
    return localBinding;
  }

  function expectedBackupPassword(login) {
    if (login === MIGRATION_LOGIN) return secretText(materials.migration);
    if (login === PROVISIONER_LOGIN) return secretText(materials.provisioner);
    fail("linux_postgres_backup_transport_login_invalid");
  }

  function exactToolExecutable(value) {
    return new Set(["/usr/bin/psql", "/usr/bin/pg_dump", "/usr/bin/pg_restore"]).has(value)
      ? value
      : "";
  }

  function snapshotToolEnvironment(value) {
    try {
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
      const names = Reflect.ownKeys(value);
      if (names.some((name) => typeof name !== "string")) return null;
      const entries = [];
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || descriptor.enumerable !== true) return null;
        entries.push([name, value[name]]);
      }
      return Object.freeze(Object.fromEntries(entries));
    } catch {
      return null;
    }
  }

  function exactArguments(actual, expected) {
    return Array.isArray(actual) && actual.length === expected.length &&
      actual.every((entry, index) => typeof entry === "string" && entry === expected[index]);
  }

  function validateBackupToolPlan(plan, localBinding) {
    const binding = requireBackupTransportBinding(localBinding);
    if (!plan || Object.getPrototypeOf(plan) !== Object.prototype) {
      fail("linux_postgres_tool_plan_refused");
    }
    const executable = exactToolExecutable(plan.executable);
    const environment = snapshotToolEnvironment(plan.env);
    if (!environment) {
      fail("linux_postgres_tool_plan_refused");
    }
    if (!executable) fail("linux_postgres_tool_command_refused");
    const providedArgs = plan.args;
    const args = Array.isArray(providedArgs)
      ? Object.freeze([...providedArgs])
      : providedArgs;
    const input = plan.input;
    const offlineCandidate = executable === "/usr/bin/pg_restore" &&
      Array.isArray(args) && args[0] === "--list";
    if (offlineCandidate) {
      if (
        args.length !== 2 ||
        typeof args[1] !== "string" ||
        path.resolve(args[1]) !== assertAbsoluteWithin(args[1], workDirectory, "linux_postgres_tool_offline_plan_refused") ||
        Object.keys(environment).some((name) => !BACKUP_SYSTEM_ENVIRONMENT_NAMES.has(name)) ||
        input !== undefined
      ) {
        fail("linux_postgres_tool_offline_plan_refused");
      }
      return Object.freeze({ args, binding, environment, executable, input, offline: true });
    }
    if (
      environment.PGHOST !== BACKUP_LOGICAL_HOST ||
      environment.PGPORT !== String(INTERNAL_PORT) ||
      environment.PGDATABASE !== binding.database ||
      environment.PGUSER !== binding.login ||
      environment.PGPASSWORD !== expectedBackupPassword(binding.login) ||
      environment.PGCONNECT_TIMEOUT !== "10" ||
      environment.PGCHANNELBINDING !== "disable" ||
      environment.PGSSLMODE !== "verify-full" ||
      environment.PGSSLROOTCERT !== "system" ||
      environment.PGAPPNAME !== BACKUP_APPLICATION_NAME ||
      typeof environment.SSL_CERT_FILE !== "string" ||
      path.resolve(environment.SSL_CERT_FILE) !== assertAbsoluteWithin(
        environment.SSL_CERT_FILE,
        workDirectory,
        "linux_postgres_tool_transport_refused"
      ) ||
      Object.keys(environment).some((name) => !BACKUP_ENVIRONMENT_NAMES.has(name))
    ) {
      fail("linux_postgres_tool_transport_refused");
    }
    const dumpFile = Array.isArray(args) && typeof args[9] === "string" &&
      args[9].startsWith("--file=") ? args[9].slice("--file=".length) : "";
    const isPsql = executable === "/usr/bin/psql" &&
      exactArguments(args, BACKUP_PSQL_ARGS) &&
      (typeof input === "string" || Buffer.isBuffer(input));
    const isDump = executable === "/usr/bin/pg_dump" &&
      exactArguments(args, [
        "--format=custom", "--compress=9", "--no-password",
        `--role=${OWNER_ROLE}`, "--schema=ia4tube_social",
        "--schema=ia4tube_social_admin", "--schema=ia4tube_migrations",
        "--lock-wait-timeout=10000", "--schema-only", args?.[9]
      ]) &&
      typeof dumpFile === "string" && dumpFile !== "" &&
      path.resolve(dumpFile) === assertAbsoluteWithin(
        dumpFile,
        workDirectory,
        "linux_postgres_tool_command_refused"
      ) && input === undefined;
    const restoreArchive = Array.isArray(args) ? args[6] : undefined;
    const isRestore = executable === "/usr/bin/pg_restore" &&
      exactArguments(args, [
        "--exit-on-error", "--single-transaction", "--no-password",
        "--no-owner", `--role=${OWNER_ROLE}`,
        `--dbname=${binding.database}`, restoreArchive
      ]) &&
      typeof restoreArchive === "string" &&
      path.resolve(restoreArchive) === assertAbsoluteWithin(
        restoreArchive,
        workDirectory,
        "linux_postgres_tool_command_refused"
      ) && input === undefined;
    if (!(isPsql || isDump || isRestore)) {
      fail("linux_postgres_tool_command_refused");
    }
    return Object.freeze({ args, binding, environment, executable, input, offline: false });
  }

  function readContainerIdentityMarker() {
    const absent = () => Object.freeze({
      present: false,
      valid: true,
      networkSha256: "",
      containerState: "",
      containerSha256: "",
      volumeSha256: ""
    });
    const invalid = () => Object.freeze({
      present: true,
      valid: false,
      networkSha256: "",
      containerState: "",
      containerSha256: "",
      volumeSha256: ""
    });
    let initialStats;
    try {
      initialStats = fs.lstatSync(containerIdentityMarker);
    } catch (error) {
      return error?.code === "ENOENT" ? absent() : invalid();
    }
    if (
      !initialStats.isFile() || initialStats.isSymbolicLink() || initialStats.nlink !== 1 ||
      initialStats.size !== IDENTITY_MARKER_SIZE ||
      (process.platform === "linux" && (initialStats.mode & 0o777) !== 0o600)
    ) {
      return invalid();
    }
    let descriptor;
    let content;
    try {
      descriptor = fs.openSync(
        containerIdentityMarker,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      const openedStats = fs.fstatSync(descriptor);
      if (
        !openedStats.isFile() || openedStats.nlink !== 1 || openedStats.size !== IDENTITY_MARKER_SIZE ||
        openedStats.dev !== initialStats.dev || openedStats.ino !== initialStats.ino ||
        (process.platform === "linux" && (openedStats.mode & 0o777) !== 0o600)
      ) return invalid();
      content = Buffer.alloc(IDENTITY_MARKER_SIZE);
      let offset = 0;
      while (offset < content.length) {
        const count = fs.readSync(descriptor, content, offset, content.length - offset, offset);
        if (count <= 0) return invalid();
        offset += count;
      }
      const value = content.toString("ascii");
      const match = value.match(new RegExp(
        `^format=${IDENTITY_MARKER_FORMAT}\\n` +
        "networkSha256=([0-9a-f]{64})\\n" +
        "containerState=(pending|present)\\n" +
        "containerSha256=([0-9a-f]{64})\\n" +
        "volumeSha256=([0-9a-f]{64})\\n$"
      ));
      const networkSha256 = match?.[1] || "";
      const containerState = match?.[2] || "";
      const containerSha256 = match?.[3] || "";
      const volumeSha256 = match?.[4] || "";
      const valid = Boolean(match) &&
        networkSha256 !== EMPTY_IDENTITY_HASH &&
        volumeSha256 !== EMPTY_IDENTITY_HASH &&
        ((containerState === "pending" && containerSha256 === EMPTY_IDENTITY_HASH) ||
          (containerState === "present" && containerSha256 !== EMPTY_IDENTITY_HASH));
      return Object.freeze({
        present: true,
        valid,
        networkSha256: valid ? networkSha256 : "",
        containerState: valid ? containerState : "",
        containerSha256: valid ? containerSha256 : "",
        volumeSha256: valid ? volumeSha256 : ""
      });
    } catch {
      return invalid();
    } finally {
      content?.fill(0);
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }

  function writeContainerIdentityMarker(containerState, observedContainerId = "") {
    if (!CONTAINER_ID.test(networkId)) fail("linux_postgres_identity_marker_invalid");
    const containerSha256 = containerState === "pending"
      ? EMPTY_IDENTITY_HASH
      : CONTAINER_ID.test(observedContainerId)
        ? resourceIdentityHash(observedContainerId)
        : "";
    const value = Buffer.from(identityMarkerText({
      networkSha256: resourceIdentityHash(networkId),
      containerState,
      containerSha256,
      volumeSha256: resourceIdentityHash(names.volume)
    }), "ascii");
    const prior = readContainerIdentityMarker();
    if (
      value.length !== IDENTITY_MARKER_SIZE ||
      (containerState === "pending" && prior.present) ||
      (containerState === "present" && (
        !prior.present || !prior.valid || prior.containerState !== "pending" ||
        prior.networkSha256 !== resourceIdentityHash(networkId) ||
        prior.volumeSha256 !== resourceIdentityHash(names.volume)
      ))
    ) {
      value.fill(0);
      fail("linux_postgres_identity_marker_invalid");
    }
    let descriptor;
    let openedPrior;
    try {
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      const flags = containerState === "pending"
        ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow
        : fs.constants.O_RDWR | noFollow;
      descriptor = fs.openSync(containerIdentityMarker, flags, 0o600);
      if (containerState === "pending") fs.fchmodSync(descriptor, 0o600);
      const openedStats = fs.fstatSync(descriptor);
      if (
        !openedStats.isFile() || openedStats.nlink !== 1 ||
        (containerState === "present" && openedStats.size !== IDENTITY_MARKER_SIZE) ||
        (process.platform === "linux" && (openedStats.mode & 0o777) !== 0o600)
      ) fail("linux_postgres_identity_marker_invalid");
      if (containerState === "present") {
        openedPrior = Buffer.alloc(IDENTITY_MARKER_SIZE);
        let readOffset = 0;
        while (readOffset < openedPrior.length) {
          const count = fs.readSync(
            descriptor,
            openedPrior,
            readOffset,
            openedPrior.length - readOffset,
            readOffset
          );
          if (count <= 0) fail("linux_postgres_identity_marker_invalid");
          readOffset += count;
        }
        const expectedPrior = identityMarkerText({
          networkSha256: resourceIdentityHash(networkId),
          containerState: "pending",
          containerSha256: EMPTY_IDENTITY_HASH,
          volumeSha256: resourceIdentityHash(names.volume)
        });
        if (openedPrior.toString("ascii") !== expectedPrior) {
          fail("linux_postgres_identity_marker_invalid");
        }
      }
      let offset = 0;
      while (offset < value.length) {
        const count = fs.writeSync(descriptor, value, offset, value.length - offset, offset);
        if (count <= 0) fail("linux_postgres_identity_marker_invalid");
        offset += count;
      }
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (error instanceof LinuxPostgresFailure) throw error;
      fail("linux_postgres_identity_marker_invalid");
    } finally {
      value.fill(0);
      openedPrior?.fill(0);
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
    const written = readContainerIdentityMarker();
    if (
      !written.present || !written.valid || written.containerState !== containerState ||
      written.networkSha256 !== resourceIdentityHash(networkId) ||
      written.containerSha256 !== containerSha256 ||
      written.volumeSha256 !== resourceIdentityHash(names.volume)
    ) fail("linux_postgres_identity_marker_invalid");
  }

  function containerIdentityMarkerExists() {
    try { fs.lstatSync(containerIdentityMarker); return true; } catch (error) {
      return error?.code !== "ENOENT";
    }
  }

  function makePool(database, login, material, max, applicationName) {
    if (!started || !privateIpv4(databaseHost) || port !== INTERNAL_PORT) {
      fail("linux_postgres_not_started");
    }
    const pool = new InstrumentedPool(poolOptions({
      host: databaseHost,
      port,
      database,
      login,
      password: secretText(material),
      max,
      applicationName
    }));
    return pool;
  }

  function adaptLogicalPoolOptions(configuration) {
    if (!plainObject(configuration) || !started || !privateIpv4(databaseHost) || port !== INTERNAL_PORT) {
      fail("linux_postgres_logical_pool_transport_refused");
    }
    if (
      configuration.host !== LOOPBACK || Number(configuration.port) !== INTERNAL_PORT ||
      configuration.ssl !== false
    ) fail("linux_postgres_logical_pool_transport_refused");
    let connectionString = configuration.connectionString;
    if (connectionString != null) {
      let parsed;
      try { parsed = new URL(connectionString); } catch { fail("linux_postgres_logical_pool_transport_refused"); }
      if (
        !new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
        parsed.hostname !== LOOPBACK || Number(parsed.port) !== INTERNAL_PORT ||
        parsed.searchParams.get("sslmode") === "require"
      ) fail("linux_postgres_logical_pool_transport_refused");
      parsed.hostname = databaseHost;
      parsed.port = String(INTERNAL_PORT);
      connectionString = parsed.toString();
    }
    return Object.freeze({
      ...configuration,
      host: databaseHost,
      port: INTERNAL_PORT,
      ssl: false,
      ...(connectionString == null ? {} : { connectionString })
    });
  }

  async function docker(args, extra = {}) {
    return run("docker", args, {
      timeoutMs: extra.timeoutMs || 120_000,
      allowFailure: extra.allowFailure,
      environment: extra.environment,
      input: extra.input,
      cwd: runnerTemp,
      failureCode: extra.failureCode || "linux_docker_command_failed"
    });
  }

  async function hostListeners(targetPort) {
    const result = await run("ss", ["-H", "-ltn"], {
      timeoutMs: 15_000,
      cwd: runnerTemp,
      failureCode: "linux_listener_probe_failed"
    });
    const rows = result.stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
    return rows.filter((row) => Number((row.split(/\s+/)[3] || "").match(/:(\d+)$/)?.[1]) === targetPort);
  }

  async function waitReady(diagnostic) {
    if (!CONTAINER_ID.test(containerId)) fail("linux_postgres_container_id_invalid");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const probe = await docker([
        "exec", containerId, "pg_isready", "--host", LOOPBACK,
        "--port", String(INTERNAL_PORT), "--username", ADMIN_LOGIN, "--dbname", "postgres"
      ], { allowFailure: true, timeoutMs: 10_000 });
      if (probe.code === 0 && probe.signal === null) {
        diagnostic.internalReadinessPassed = true;
        return true;
      }
      await readinessDelay(1000);
    }
    fail("linux_postgres_readiness_failed", diagnostic);
  }

  async function verifyImage() {
    const result = await docker(["image", "inspect", IMAGE, "--format", "{{json .}}"], {
      failureCode: "linux_postgres_image_inspect_failed"
    });
    let value;
    try { value = JSON.parse(result.stdout.trim()); } catch { fail("linux_postgres_image_metadata_invalid"); }
    if (
      value?.Os !== "linux" || value?.Architecture !== "amd64" ||
      !Array.isArray(value?.RepoDigests) ||
      !value.RepoDigests.some((item) => String(item).endsWith(`@${IMAGE_DIGEST}`))
    ) {
      fail("linux_postgres_image_identity_mismatch");
    }
    return true;
  }

  async function startWithDiagnostic(diagnostic) {
    if (started || fs.existsSync(runRoot) || containerIdentityMarkerExists()) {
      fail("linux_postgres_root_collision");
    }
    fs.mkdirSync(runRoot, { recursive: false, mode: 0o700 });
    fs.mkdirSync(dataDirectory, { recursive: false, mode: 0o700 });
    fs.mkdirSync(workDirectory, { recursive: false, mode: 0o700 });
    fs.writeFileSync(passwordFile, `${secretText(materials.admin)}\n`, { flag: "wx", mode: 0o600 });
    fs.chmodSync(passwordFile, 0o600);
    await docker(["pull", "--platform", "linux/amd64", IMAGE], {
      timeoutMs: 10 * 60_000,
      failureCode: "linux_postgres_image_pull_failed"
    });
    await verifyImage();
    beginFailureStage(diagnostic, "network_create");
    const networkCreateResult = assertCommandSucceeded(await docker([
      "network", "create", "--driver", "bridge", "--internal", "--label", names.label, names.network
    ], {
      failureCode: "linux_postgres_network_create_failed",
      allowFailure: true
    }), "linux_postgres_network_create_failed", diagnostic);
    diagnostic.networkCreated = true;
    beginFailureStage(diagnostic, "network_id");
    const networkIdMatch = String(networkCreateResult.stdout || "").match(/^([0-9a-f]{64})(?:\r?\n)?$/);
    if (!networkIdMatch) fail("linux_postgres_network_id_invalid", diagnostic);
    networkId = networkIdMatch[1];
    writeContainerIdentityMarker("pending");
    beginFailureStage(diagnostic, "volume_create");
    await docker([
      "volume", "create", "--driver", "local", "--label", names.label,
      "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${dataDirectory}`,
      names.volume
    ], { failureCode: "linux_postgres_volume_create_failed" });
    volumeCreated = true;
    beginFailureStage(diagnostic, "docker_run");
    const runResult = assertCommandSucceeded(await docker([
      "run", "--detach", "--name", names.container, "--hostname", names.container,
      "--label", names.label, "--network", names.network, "--log-driver", "none",
      "--mount", `type=volume,src=${names.volume},dst=/var/lib/postgresql`,
      "--mount", `type=bind,src=${runRoot},dst=${runRoot}`,
      "--mount", `type=bind,src=${passwordFile},dst=/run/secrets/postgres-password,readonly`,
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password",
      "--env", `POSTGRES_USER=${ADMIN_LOGIN}`, "--env", "POSTGRES_DB=postgres",
      "--env", "PGDATA=/var/lib/postgresql/18/docker", "--env", "LANG=C",
      "--env", "LC_ALL=C", "--env", "POSTGRES_INITDB_ARGS=--data-checksums --encoding=UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=scram-sha-256",
      IMAGE, "postgres", "-c", "listen_addresses=*", "-c", "password_encryption=scram-sha-256"
    ], {
      timeoutMs: 120_000,
      failureCode: "linux_postgres_container_start_failed",
      allowFailure: true
    }), "linux_postgres_container_start_failed", diagnostic);
    diagnostic.containerCreated = true;
    started = true;
    diagnostic.failureStage = "container_id";
    const observedContainerId = String(runResult.stdout || "");
    const containerIdMatch = observedContainerId.match(/^([0-9a-f]{64})(?:\r?\n)?$/);
    if (!containerIdMatch) fail("linux_postgres_container_id_invalid", diagnostic);
    containerId = containerIdMatch[1];
    writeContainerIdentityMarker("present", containerId);
    beginFailureStage(diagnostic, "internal_readiness");
    await waitReady(diagnostic);

    beginFailureStage(diagnostic, "network_inspect");
    const networkInspectResult = assertCommandSucceeded(await docker([
      "network", "inspect", "--format", "{{json .}}", networkId
    ], {
      failureCode: "linux_postgres_network_inspect_failed",
      allowFailure: true
    }), "linux_postgres_network_inspect_failed", diagnostic);
    const inspectedNetwork = inspectInternalNetwork(networkInspectResult.stdout, {
      networkId,
      containerId,
      names,
      diagnostic
    });
    Object.assign(diagnostic, inspectedNetwork.diagnostic);

    beginFailureStage(diagnostic, "container_inspect");
    const inspectResult = assertCommandSucceeded(await docker([
      "inspect", "--type=container", "--format", "{{json .}}", containerId
    ], {
      failureCode: "linux_postgres_container_inspect_failed",
      allowFailure: true
    }), "linux_postgres_container_inspect_failed", diagnostic);
    const inspected = inspectInternalContainer(inspectResult.stdout, {
      containerId,
      networkId,
      names,
      network: inspectedNetwork,
      diagnostic
    });
    Object.assign(diagnostic, inspected.diagnostic);
    databaseHost = inspected.databaseHost;
    port = INTERNAL_PORT;

    beginFailureStage(diagnostic, "container_listing");
    const listingResult = assertCommandSucceeded(await docker([
      "ps", "--no-trunc", "--all", "--filter", `id=${containerId}`, "--format", "{{json .}}"
    ], {
      failureCode: "linux_postgres_container_listing_failed",
      allowFailure: true
    }), "linux_postgres_container_listing_failed", diagnostic);
    inspectContainerListing(listingResult.stdout, { containerId, names, diagnostic });

    beginFailureStage(diagnostic, "host_listener");
    const listeners = await hostListeners(port);
    const listenerClass = classifyHostListenerRows(listeners, port);
    diagnostic.hostListenerAbsent = listenerClass === "none_observed";
    const admin = makePool("postgres", ADMIN_LOGIN, materials.admin, 1, "ia4tube-social-3a0p-administration");
    try {
      beginFailureStage(diagnostic, "host_direct_connection");
      diagnostic.hostDirectConnectionAttempted = true;
      const result = await admin.query([
        "SELECT current_setting('server_version_num') AS version_num,",
        " current_setting('server_encoding') AS encoding,",
        " current_setting('data_checksums') AS checksums,",
        " current_setting('password_encryption') AS password_encryption,",
        " (SELECT datcollate FROM pg_catalog.pg_database WHERE datname=current_database()) AS datcollate,",
        " (SELECT datctype FROM pg_catalog.pg_database WHERE datname=current_database()) AS datctype,",
        " (SELECT COALESCE(bool_and(auth_method='scram-sha-256'),false) FROM pg_catalog.pg_hba_file_rules WHERE error IS NULL AND type IN('local','host','hostssl','hostnossl')) AS hba_scram,",
        " (SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_catalog.pg_authid WHERE rolname=current_user) AS admin_password_scram,",
        " 1::integer AS selected"
      ].join("\n"));
      const row = result.rows?.[0];
      if (
        row?.version_num !== "180004" || row?.encoding !== "UTF8" ||
        row?.checksums !== "on" || row?.password_encryption !== "scram-sha-256" ||
        row?.datcollate !== "C" || row?.datctype !== "C" ||
        row?.hba_scram !== true || row?.admin_password_scram !== true ||
        Number(row?.selected) !== 1
      ) {
        fail("linux_postgres_runtime_identity_invalid", diagnostic);
      }
      diagnostic.hostDirectConnectionPassed = true;
    } catch (error) {
      if (error instanceof LinuxPostgresFailure) throw error;
      fail("linux_postgres_host_direct_connection_failed", diagnostic);
    } finally {
      await admin.end();
    }
    if (!diagnostic.hostListenerAbsent || !diagnostic.hostDirectConnectionPassed) {
      fail("linux_postgres_internal_bridge_direct_invalid", diagnostic);
    }
    diagnostic.failureStage = "complete";
    return Object.freeze({
      image: IMAGE,
      imageDigest: IMAGE_DIGEST,
      architecture: "linux/amd64",
      version: "18.4",
      dataChecksums: true,
      encoding: "UTF8",
      locale: "C",
      scramSha256: true,
      hostAuthenticationScramSha256: true,
      connectivityMode: POSTGRES_CONNECTIVITY_MODE,
      containerIdCaptured: true,
      containerIdMatched: true,
      structuredInspectCompleted: true,
      networkInternal: true,
      networkDriver: "bridge",
      containerAttachedNetworkCount: 1,
      publishedPortCount: 0,
      hostPortBindingAbsent: true,
      noHostPortPublished: true,
      internalNetworkProved: true,
      internalReadinessPassed: true,
      internalBridgeDirectConnectionProved: true,
      hostDirectContainerIpConnectionPassed: true,
      externalPortExposureAbsent: true,
      hostListenerAbsent: true,
      port
    });
  }

  async function start() {
    const diagnostic = { ...diagnosticDefaults(), failureStage: "pre_network" };
    try {
      return await startWithDiagnostic(diagnostic);
    } catch (error) {
      if (error instanceof LinuxPostgresFailure) {
        const errorDiagnostic = postgresFailureDiagnostics(error);
        if (errorDiagnostic?.failureStage !== "unknown") {
          throw new LinuxPostgresFailure(error.code, errorDiagnostic);
        }
        throw new LinuxPostgresFailure(error.code, diagnostic);
      }
      throw new LinuxPostgresFailure("linux_postgres_start_failed", diagnostic);
    }
  }

  async function bootstrap(repositoryRoot, environmentId) {
    if (!started || port !== INTERNAL_PORT || !privateIpv4(databaseHost)) fail("linux_postgres_not_started");
    const loginBootstrap = require("../src/persistence/postgres/login-bootstrap");
    const rolesSql = fs.readFileSync(path.join(repositoryRoot, "db", "postgres", "roles.sql"), "utf8");
    const admin = makePool("postgres", ADMIN_LOGIN, materials.admin, 1, "ia4tube-social-3a0p-administration");
    let provisioner;
    try {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL password_encryption='scram-sha-256'");
        await client.query("SELECT set_config('ia4tube.provisioner_login',$1,true),set_config('ia4tube.provisioner_password',$2,true)", [PROVISIONER_LOGIN, secretText(materials.provisioner)]);
        await client.query([
          "DO $bootstrap$ DECLARE l text:=current_setting('ia4tube.provisioner_login'); p text:=current_setting('ia4tube.provisioner_password');",
          "BEGIN EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',l,p); END $bootstrap$;"
        ].join("\n"));
        await client.query("COMMIT");
        await client.query(`CREATE DATABASE ${quoteIdentifier(DATABASE)} OWNER ${quoteIdentifier(PROVISIONER_LOGIN)}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      provisioner = makePool(DATABASE, PROVISIONER_LOGIN, materials.provisioner, 1, "ia4tube-social-3a0p-provisioner");
      const owner = await provisioner.connect();
      try {
        await owner.query(rolesSql);
        await owner.query("BEGIN");
        await owner.query("GRANT ia4tube_social_owner TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER");
        await owner.query("SET LOCAL ROLE ia4tube_social_owner");
        await owner.query("INSERT INTO ia4tube_migrations.environment_identity(singleton,environment_id,environment_name) VALUES(TRUE,$1,'local')", [environmentId]);
        await owner.query("RESET ROLE");
        await owner.query("REVOKE ia4tube_social_owner FROM CURRENT_USER GRANTED BY CURRENT_USER RESTRICT");
        await owner.query("COMMIT");
      } catch (error) {
        await owner.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        owner.release();
      }
      const target = {
        host: LOOPBACK, port: String(port), database: DATABASE,
        provisionerLogin: PROVISIONER_LOGIN, migrationLogin: MIGRATION_LOGIN, runtimeLogin: RUNTIME_LOGIN
      };
      const connectionString = new URL(`postgresql://${databaseHost}:${port}/${DATABASE}`);
      connectionString.username = PROVISIONER_LOGIN;
      connectionString.password = secretText(materials.provisioner);
      const configuration = {
        target,
        targetFingerprint: loginBootstrap.targetFingerprint(target),
        provisionerPool: { ...poolOptions({ host: databaseHost, port, database: DATABASE, login: PROVISIONER_LOGIN, password: secretText(materials.provisioner), max: 1, applicationName: "ia4tube-social-3a0p-provisioner" }), connectionString: connectionString.toString() },
        migration: { login: MIGRATION_LOGIN, role: MIGRATOR_ROLE, connectionLimit: loginBootstrap.MIGRATION_CONNECTION_LIMIT },
        runtime: { login: RUNTIME_LOGIN, role: RUNTIME_ROLE, connectionLimit: loginBootstrap.RUNTIME_CONNECTION_LIMIT }
      };
      Object.defineProperty(configuration.migration, "password", { value: secretText(materials.migration), enumerable: false });
      Object.defineProperty(configuration.runtime, "password", { value: secretText(materials.runtime), enumerable: false });
      const first = await loginBootstrap.bootstrapDatabaseLogins(provisioner, configuration);
      const second = await loginBootstrap.bootstrapDatabaseLogins(provisioner, configuration);
      const verified = await loginBootstrap.verifyProvisionedLoginCredentials(InstrumentedPool, configuration);
      if (first.safe !== true || second.safe !== true || second.created?.migration !== false || second.created?.runtime !== false || verified.verified !== 2) {
        fail("linux_postgres_role_bootstrap_invalid");
      }
      const migration = makePool(DATABASE, MIGRATION_LOGIN, materials.migration, 2, "ia4tube-social-3a0p-migration");
      const runtime = makePool(DATABASE, RUNTIME_LOGIN, materials.runtime, 3, "ia4tube-social-3a0p-runtime");
      const runtimePoolConfiguredMax = Number(runtime.options?.max);
      if (runtimePoolConfiguredMax !== 3) fail("linux_postgres_runtime_pool_max_invalid");
      return Object.freeze({
        pools: Object.freeze({ migration, runtime }),
        roles: Object.freeze({
          admin: ADMIN_LOGIN, provisioner: PROVISIONER_LOGIN, migrationLogin: MIGRATION_LOGIN,
          runtimeLogin: RUNTIME_LOGIN, ownerRole: OWNER_ROLE, migratorRole: MIGRATOR_ROLE, runtimeRole: RUNTIME_ROLE
        }),
        checks: Object.freeze({
          roleBootstrapIdempotent: true,
          runtimePoolMax3: runtimePoolConfiguredMax === 3,
          runtimePoolConfiguredMax,
          syntheticCredentialsOnly: true
        })
      });
    } finally {
      if (provisioner) await provisioner.end();
      await admin.end();
    }
  }

  function createRunTool() {
    return async (plan, localBinding) => {
      if (!CONTAINER_ID.test(containerId)) fail("linux_postgres_container_id_invalid");
      const validated = validateBackupToolPlan(plan, localBinding);
      const executable = path.posix.basename(validated.executable);
      const environment = validated.environment;
      const dockerArgs = ["exec", "--interactive", "--user", `${runnerUid}:${runnerGid}`];
      const childEnvironment = {};
      if (!validated.offline) {
        Object.assign(childEnvironment, {
          PGPASSWORD: environment.PGPASSWORD,
          PGHOST: LOOPBACK,
          PGPORT: String(INTERNAL_PORT),
          PGDATABASE: environment.PGDATABASE,
          PGUSER: environment.PGUSER,
          PGSSLMODE: "disable",
          PGCHANNELBINDING: "disable",
          PGCONNECT_TIMEOUT: "10",
          PGAPPNAME: BACKUP_APPLICATION_NAME
        });
        for (const name of Object.keys(childEnvironment)) dockerArgs.push("--env", name);
      }
      dockerArgs.push(containerId, executable, ...validated.args);
      if (!validated.offline) backupTransportAttemptedExecutables.add(executable);
      try {
        const result = await docker(dockerArgs, {
          allowFailure: true,
          timeoutMs: 10 * 60_000,
          environment: childEnvironment,
          input: validated.input,
          failureCode: "linux_postgres_tool_execution_failed"
        });
        if (result.code === 0 && result.signal === null && !validated.offline) {
          backupTransportSucceededExecutables.add(executable);
        }
        return Object.freeze({ code: result.code, stdout: result.stdout, stderr: result.stderr });
      } finally {
        childEnvironment.PGPASSWORD = "";
      }
    };
  }

  function backupTransportEvidence() {
    const logicalValidated = backupTransportAttemptedExecutables.size > 0;
    const complete = ["psql", "pg_dump", "pg_restore"].every((name) => (
      backupTransportSucceededExecutables.has(name)
    ));
    return Object.freeze({
      logicalIdentityTlsContractValidated: logicalValidated,
      physicalDisposableTransportValidated: complete,
      productionTlsPhysicallyTestedInThisGate: false,
      productionTlsPreviouslyProvedBySocial2B: true,
      localTlsDisabledOnlyInsideOwnedContainer: logicalValidated,
      pgDumpStarted: backupTransportAttemptedExecutables.has("pg_dump"),
      pgDumpSucceeded: backupTransportSucceededExecutables.has("pg_dump"),
      pgRestoreStarted: backupTransportAttemptedExecutables.has("pg_restore"),
      pgRestoreSucceeded: backupTransportSucceededExecutables.has("pg_restore")
    });
  }

  async function sessionRows(adminPool) {
    const result = await adminPool.query([
      "SELECT pid,usename AS role,state,application_name",
      "FROM pg_catalog.pg_stat_activity",
      "WHERE pid<>pg_backend_pid() AND datname=$1 AND backend_type='client backend'",
      "ORDER BY pid"
    ].join("\n"), [DATABASE]);
    return result.rows.map((row) => Object.freeze({
      pid: Number(row.pid), role: row.role, state: row.state, applicationName: row.application_name
    }));
  }

  async function orphanSessionCount(adminPool) {
    const result = await adminPool.query(
      "SELECT COUNT(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=$1 AND backend_type='client backend'",
      [DATABASE]
    );
    const count = Number(result.rows?.[0]?.n);
    if (!Number.isSafeInteger(count) || count < 0) fail("linux_postgres_session_count_invalid");
    return count;
  }

  async function scanDataDirectoryMarkers(markers) {
    if (!CONTAINER_ID.test(containerId)) fail("linux_postgres_container_id_invalid");
    if (!Array.isArray(markers) || markers.length < 1 || markers.some((marker) => (
      typeof marker !== "string" || marker.length < 16 || /[\0\r\n]/.test(marker)
    ))) fail("linux_postgres_marker_scan_input_invalid");
    const input = Buffer.from(`${markers.join("\n")}\n`, "utf8");
    try {
      const result = await docker([
        "exec", "--interactive", "--user", "0:0", containerId,
        "grep", "-rFqa", "--devices=skip", "-f", "-", "--", "/var/lib/postgresql/18/docker"
      ], {
        allowFailure: true,
        input,
        timeoutMs: 120_000,
        failureCode: "linux_postgres_data_marker_scan_failed"
      });
      if (result.stdout !== "" || result.stderr !== "" || !new Set([0, 1]).has(result.code) || result.signal !== null) {
        fail("linux_postgres_data_marker_scan_failed");
      }
      return Object.freeze({ markersPresent: result.code === 0, scanCompleted: true });
    } finally {
      input.fill(0);
    }
  }

  async function cleanup() {
    let poolCloseError;
    let poolCloseFailed = false;
    for (const pool of [...trackedPools]) {
      try {
        await pool.end();
      } catch (error) {
        if (!poolCloseFailed) {
          poolCloseError = error;
          poolCloseFailed = true;
        }
      }
    }
    let commandFailures = 0;
    const invoke = async (args, extra = {}) => {
      try {
        const result = await docker(args, { ...extra, allowFailure: true });
        if (result.code !== 0 || result.signal !== null) commandFailures += 1;
        return result;
      } catch {
        commandFailures += 1;
        return null;
      }
    };
    const lines = (result) => result?.code === 0 && result.signal === null
      ? result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : [];
    const containerByLabelBefore = await invoke([
      "ps", "--no-trunc", "--all", "--quiet", "--filter", `label=${names.label}`
    ]);
    const containerByNameBefore = await invoke([
      "ps", "--no-trunc", "--all", "--quiet", "--filter", `name=^/${names.container}$`
    ]);
    const allContainersBefore = await invoke(["ps", "--no-trunc", "--all", "--quiet"]);
    const volumeBefore = await invoke(["volume", "ls", "--quiet", "--filter", `label=${names.label}`]);
    const volumeByNameBefore = await invoke([
      "volume", "ls", "--quiet", "--filter", `name=^${names.volume}$`
    ]);
    const networkBefore = await invoke([
      "network", "ls", "--no-trunc", "--quiet", "--filter", `label=${names.label}`
    ]);
    const networkByNameBefore = await invoke([
      "network", "ls", "--no-trunc", "--quiet", "--filter", `name=^${names.network}$`
    ]);
    const labeledContainersBefore = lines(containerByLabelBefore);
    const namedContainersBefore = lines(containerByNameBefore);
    const ownedContainersBefore = labeledContainersBefore.length === 1 &&
      namedContainersBefore.length === 1 && labeledContainersBefore[0] === namedContainersBefore[0]
      ? [labeledContainersBefore[0]]
      : [];
    const allContainerIdsBefore = lines(allContainersBefore);
    const ownedVolumesBefore = volumeBefore?.code === 0
      ? volumeBefore.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : [];
    const namedVolumesBefore = lines(volumeByNameBefore);
    const ownedNetworksBefore = lines(networkBefore);
    const namedNetworksBefore = lines(networkByNameBefore);
    const inventorySucceeded = (result) => result?.code === 0 && result.signal === null;
    const marker = readContainerIdentityMarker();
    const inMemoryContainerIdentityHash = CONTAINER_ID.test(containerId)
      ? resourceIdentityHash(containerId)
      : "";
    const expectedContainerIdentityHash = inMemoryContainerIdentityHash ||
      (marker.valid && marker.containerState === "present" ? marker.containerSha256 : "");
    const inMemoryNetworkIdentityHash = CONTAINER_ID.test(networkId)
      ? resourceIdentityHash(networkId)
      : "";
    const expectedNetworkIdentityHash = inMemoryNetworkIdentityHash ||
      (marker.valid ? marker.networkSha256 : "");
    const expectedContainerIds = expectedContainerIdentityHash === ""
      ? []
      : allContainerIdsBefore.filter((item) => (
        CONTAINER_ID.test(item) && resourceIdentityHash(item) === expectedContainerIdentityHash
      ));
    const expectedVolumeIdentityHash = resourceIdentityHash(names.volume);
    const volumeOwnershipExpected = volumeCreated || (
      marker.present && marker.valid && marker.volumeSha256 === expectedVolumeIdentityHash
    );
    const pendingContainerDiscoveryAuthorized = marker.present && marker.valid &&
      marker.containerState === "pending" && marker.volumeSha256 === expectedVolumeIdentityHash;
    const resourceIdentityConflict = (
      !inventorySucceeded(containerByLabelBefore) ||
      !inventorySucceeded(containerByNameBefore) ||
      !inventorySucceeded(allContainersBefore) ||
      !inventorySucceeded(volumeBefore) ||
      !inventorySucceeded(volumeByNameBefore) ||
      !inventorySucceeded(networkBefore) ||
      !inventorySucceeded(networkByNameBefore) ||
      labeledContainersBefore.length > 1 ||
      namedContainersBefore.length > 1 ||
      labeledContainersBefore.some((item) => !CONTAINER_ID.test(item)) ||
      namedContainersBefore.some((item) => !CONTAINER_ID.test(item)) ||
      JSON.stringify(labeledContainersBefore) !== JSON.stringify(namedContainersBefore) ||
      allContainerIdsBefore.some((item) => !CONTAINER_ID.test(item)) ||
      new Set(allContainerIdsBefore).size !== allContainerIdsBefore.length ||
      labeledContainersBefore.some((item) => !allContainerIdsBefore.includes(item)) ||
      namedContainersBefore.some((item) => !allContainerIdsBefore.includes(item)) ||
      (marker.present && !marker.valid) ||
      (marker.present && inMemoryContainerIdentityHash !== "" &&
        marker.containerState === "present" && marker.containerSha256 !== inMemoryContainerIdentityHash) ||
      (marker.present && inMemoryNetworkIdentityHash !== "" &&
        marker.networkSha256 !== inMemoryNetworkIdentityHash) ||
      (marker.present && marker.valid && marker.volumeSha256 !== expectedVolumeIdentityHash) ||
      (containerId !== "" && (
        !CONTAINER_ID.test(containerId) ||
        (ownedContainersBefore.length === 1 && ownedContainersBefore[0] !== containerId)
      )) ||
      (ownedContainersBefore.length === 1 && expectedContainerIdentityHash !== "" && (
        resourceIdentityHash(ownedContainersBefore[0]) !== expectedContainerIdentityHash
      )) ||
      expectedContainerIds.length > 1 ||
      (expectedContainerIds.length === 1 && (
        ownedContainersBefore.length !== 1 || ownedContainersBefore[0] !== expectedContainerIds[0]
      )) ||
      (expectedContainerIds.length === 0 && expectedContainerIdentityHash !== "" && ownedContainersBefore.length !== 0) ||
      (ownedContainersBefore.length === 1 && expectedContainerIdentityHash === "" &&
        !pendingContainerDiscoveryAuthorized && containerId === "") ||
      ownedVolumesBefore.length > 1 ||
      ownedVolumesBefore.some((item) => item !== names.volume) ||
      namedVolumesBefore.length > 1 ||
      namedVolumesBefore.some((item) => item !== names.volume) ||
      JSON.stringify(ownedVolumesBefore) !== JSON.stringify(namedVolumesBefore) ||
      (ownedVolumesBefore.length === 1 && !volumeOwnershipExpected) ||
      ownedNetworksBefore.length > 1 ||
      namedNetworksBefore.length > 1 ||
      ownedNetworksBefore.some((item) => !CONTAINER_ID.test(item)) ||
      namedNetworksBefore.some((item) => !CONTAINER_ID.test(item)) ||
      JSON.stringify(ownedNetworksBefore) !== JSON.stringify(namedNetworksBefore) ||
      (networkId !== "" && !CONTAINER_ID.test(networkId)) ||
      (ownedNetworksBefore.length === 1 && expectedNetworkIdentityHash === "") ||
      (ownedNetworksBefore.length === 1 && expectedNetworkIdentityHash !== "" &&
        resourceIdentityHash(ownedNetworksBefore[0]) !== expectedNetworkIdentityHash)
    );
    let destructiveCleanupAuthorized = !resourceIdentityConflict;
    if (resourceIdentityConflict) {
      commandFailures += 1;
    } else {
      if (ownedContainersBefore.length === 1) {
        const removalId = ownedContainersBefore[0];
        const removal = await invoke(["rm", "--force", "--volumes", removalId], { timeoutMs: 60_000 });
        if (!inventorySucceeded(removal)) {
          destructiveCleanupAuthorized = false;
        } else {
          const exactAfterRemoval = await invoke([
            "ps", "--no-trunc", "--all", "--quiet", "--filter", `label=${names.label}`
          ]);
          const namedAfterRemoval = await invoke([
            "ps", "--no-trunc", "--all", "--quiet", "--filter", `name=^/${names.container}$`
          ]);
          const allAfterRemoval = await invoke(["ps", "--no-trunc", "--all", "--quiet"]);
          const exactAfterIds = lines(exactAfterRemoval);
          const namedAfterIds = lines(namedAfterRemoval);
          const allAfterIds = lines(allAfterRemoval);
          if (
            !inventorySucceeded(exactAfterRemoval) || !inventorySucceeded(namedAfterRemoval) ||
            !inventorySucceeded(allAfterRemoval) || exactAfterIds.length !== 0 ||
            namedAfterIds.length !== 0 || allAfterIds.includes(removalId) ||
            allAfterIds.some((item) => !CONTAINER_ID.test(item))
          ) {
            commandFailures += 1;
            destructiveCleanupAuthorized = false;
          }
        }
      }
    }
    if (destructiveCleanupAuthorized) {
      if (ownedVolumesBefore.includes(names.volume)) {
        await invoke([
          "run", "--rm", "--network", "none", "--log-driver", "none",
          "--label", names.label, "--user", "0:0",
          "--mount", `type=volume,src=${names.volume},dst=/owned`,
          IMAGE, "chown", "-R", `${runnerUid}:${runnerGid}`, "/owned"
        ], { timeoutMs: 120_000 });
        await invoke(["volume", "rm", "--force", names.volume], { timeoutMs: 60_000 });
      }
      if (ownedNetworksBefore.length === 1) {
        await invoke(["network", "rm", ownedNetworksBefore[0]], { timeoutMs: 60_000 });
      }
      try {
        if (fs.existsSync(runRoot)) fs.rmSync(runRoot, { recursive: true, force: false, maxRetries: 0 });
      } catch {
        commandFailures += 1;
      }
    }
    const containers = await invoke(["ps", "--no-trunc", "--all", "--quiet", "--filter", `label=${names.label}`]);
    const containersByName = await invoke([
      "ps", "--no-trunc", "--all", "--quiet", "--filter", `name=^/${names.container}$`
    ]);
    const volumes = await invoke(["volume", "ls", "--quiet", "--filter", `label=${names.label}`]);
    const networks = await invoke(["network", "ls", "--quiet", "--filter", `label=${names.label}`]);
    const volumesByName = await invoke(["volume", "ls", "--quiet", "--filter", `name=^${names.volume}$`]);
    const networksByName = await invoke(["network", "ls", "--quiet", "--filter", `name=^${names.network}$`]);
    const listeners = await hostListeners(INTERNAL_PORT).catch(() => ["probe-failed"]);
    for (const material of Object.values(materials)) material.fill(0);
    const containerResiduals = containers?.code === 0 && containersByName?.code === 0 &&
      !containers.stdout.trim() && !containersByName.stdout.trim() ? 0 : 1;
    const volumeResiduals = volumes?.code === 0 && volumesByName?.code === 0 &&
      !volumes.stdout.trim() && !volumesByName.stdout.trim() ? 0 : 1;
    const networkResiduals = networks?.code === 0 && networksByName?.code === 0 &&
      !networks.stdout.trim() && !networksByName.stdout.trim() ? 0 : 1;
    if (
      commandFailures === 0 && containerResiduals === 0 && volumeResiduals === 0 &&
      networkResiduals === 0 && listeners.length === 0 && !fs.existsSync(runRoot) &&
      containerIdentityMarkerExists()
    ) {
      try { fs.unlinkSync(containerIdentityMarker); } catch { commandFailures += 1; }
    }
    const identityMarkerResiduals = containerIdentityMarkerExists() ? 1 : 0;
    const result = Object.freeze({
      containerResiduals,
      volumeResiduals,
      networkResiduals,
      listenerResiduals: listeners.length,
      temporaryRootResiduals: (fs.existsSync(runRoot) ? 1 : 0) + identityMarkerResiduals,
      containerRemoved: containerResiduals === 0,
      volumeRemoved: volumeResiduals === 0,
      networkRemoved: networkResiduals === 0,
      syntheticCredentialMaterialRemoved: !fs.existsSync(passwordFile),
      cleanupCompleted: commandFailures === 0 && containerResiduals === 0 && volumeResiduals === 0 && networkResiduals === 0 && listeners.length === 0 && !fs.existsSync(runRoot) && identityMarkerResiduals === 0 && trackedPools.size === 0
    });
    if (result.cleanupCompleted) {
      started = false;
      containerId = "";
      networkId = "";
      volumeCreated = false;
      databaseHost = "";
      port = 0;
    }
    if (poolCloseFailed) throw poolCloseError;
    if (!result.cleanupCompleted) fail("linux_postgres_cleanup_incomplete");
    return result;
  }

  return Object.freeze({
    adaptLogicalPoolOptions,
    backupTransportEvidence,
    bootstrap,
    cleanup,
    createBackupTransportBinding,
    createRunTool,
    get InstrumentedPool() { return InstrumentedPool; },
    get materials() { return materials; },
    get names() { return names; },
    get databaseHost() { return databaseHost; },
    get port() { return port; },
    get runRoot() { return runRoot; },
    get workDirectory() { return workDirectory; },
    get trackedPoolCount() { return trackedPools.size; },
    makePool,
    orphanSessionCount,
    scanDataDirectoryMarkers,
    sessionRows,
    start
  });
}

module.exports = {
  ADMIN_LOGIN,
  BACKUP_CONNECTIVITY_MODE,
  BACKUP_LOGICAL_HOST,
  BACKUP_PHYSICAL_MODE,
  DATABASE,
  IMAGE,
  IMAGE_DIGEST,
  classifyHostListenerRows,
  inspectContainerListing,
  inspectInternalContainer,
  inspectInternalNetwork,
  INTERNAL_PORT,
  LOOPBACK,
  LinuxPostgresFailure,
  MIGRATION_LOGIN,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  POSTGRES_CONNECTIVITY_MODE,
  postgresFailureDiagnostics,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  RUNTIME_ROLE,
  commandRunner,
  createLinuxPostgres,
  dockerNames,
  generatedSecret,
  instrumentedPoolClass,
  poolOptions,
  safeRunId
};
